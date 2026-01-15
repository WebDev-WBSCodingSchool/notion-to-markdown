import { Buffer } from 'node:buffer';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@notionhq/client';
import { getCurriculumContent, getChildPages } from './utils/notionDatabase.js';
import { processImagesInMarkdown } from './utils/images.js';
import { slugifyPath } from './utils/text.js';
import { generateFrontMatter, extractPageMetadata } from './utils/frontmatter.js';
import { setupMarkdownTransformer } from './utils/markdown.js';

const notionSecret = process.env.NOTION_SECRET;
const database = process.argv[2];
const targetDir = process.argv[3];
const repoUrl = process.argv[4] || process.env.REPO_URL || '';

if (!notionSecret) {
  console.error('NOTION_SECRET missing in environment');
  process.exit(1);
}

if (!database) {
  console.error('No database ID provided as argument');
  process.exit(1);
}

if (!targetDir) {
  console.error('No target directory provided as argument');
  process.exit(1);
}

await mkdir(targetDir, { recursive: true });

const JSON_FILE = path.join(targetDir, 'curriculum.json');
const PROGRESS_FILE = path.join(targetDir, '.progress.json');
const curriculumData = [];
const curriculumDataMap = new Map();

const notion = new Client({
  auth: notionSecret
});

const n2m = setupMarkdownTransformer(notion);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const getRetryAfter = (error) => {
  if (error.headers) {
    const retryAfter = error.headers.get?.('retry-after') || error.headers['retry-after'];
    if (retryAfter) {
      const seconds = parseInt(retryAfter, 10);
      if (!isNaN(seconds)) {
        return seconds * 1000;
      }
    }
  }
  return 60000;
};

const writeMDFile = async (notionObj, index, total) => {
  const { properties } = notionObj;
  const unit = properties.Unit?.select.name;
  const chapter = properties.Chapter?.select.name;
  const name = properties.Name?.title.map((t) => t.plain_text).join('');

  if (!unit || !chapter || !name) {
    console.error(`Missing required properties for page ID ${notionObj.id}. Skipping.`);
    return;
  }

  const frontMatter = generateFrontMatter(notionObj);
  const mdBlocks = await n2m.pageToMarkdown(notionObj.id);
  const { parent } = n2m.toMarkdownString(mdBlocks);
  
  if (!parent) {
    console.error(`No content found for page ID ${notionObj.id}. Skipping.`);
    return;
  }

  const slugifiedPath = slugifyPath(unit, chapter, name);
  const fileLocation = `${slugifiedPath}.md`;
  const filepath = path.join(targetDir, fileLocation);
  const fileDir = path.dirname(filepath);
  
  await mkdir(fileDir, { recursive: true });
  
  const processedContent = await processImagesInMarkdown(parent, fileDir, filepath, targetDir, repoUrl, notionSecret);
  const data = new Uint8Array(Buffer.from(frontMatter.concat(processedContent)));
  await writeFile(filepath, data);

  try {
    const childPages = await getChildPages(notionObj.id);
    if (childPages.length > 0) {
      const solutionPage = childPages[0];
      const solutionMdBlocks = await n2m.pageToMarkdown(solutionPage.id);
      const { parent: solutionContent } = n2m.toMarkdownString(solutionMdBlocks);
      
      if (solutionContent) {
        const solutionFileLocation = `solutions/${slugifiedPath}.md`;
        const solutionFilepath = path.join(targetDir, solutionFileLocation);
        const solutionFileDir = path.dirname(solutionFilepath);
        
        await mkdir(solutionFileDir, { recursive: true });
        
        const processedSolutionContent = await processImagesInMarkdown(solutionContent, solutionFileDir, solutionFilepath, targetDir, repoUrl, notionSecret);
        const solutionData = new Uint8Array(Buffer.from(frontMatter.concat(processedSolutionContent)));
        await writeFile(solutionFilepath, solutionData);
        
        console.log(`  └─ Solution saved: ${solutionFileLocation}`);
      }
    }
  } catch (error) {
    if (error.code === 'rate_limited') {
      throw error;
    }
    console.error(`Error processing child pages for ${notionObj.id}:`, error.message);
  }

  const metadata = extractPageMetadata(notionObj);
  const entry = {
    ...metadata,
    repo_path: fileLocation
  };
  
  if (!curriculumDataMap.has(notionObj.id)) {
    curriculumDataMap.set(notionObj.id, entry);
    curriculumData.push(entry);
  } else {
    const existingIndex = curriculumData.findIndex(item => curriculumDataMap.get(notionObj.id) === item);
    if (existingIndex !== -1) {
      curriculumData[existingIndex] = entry;
      curriculumDataMap.set(notionObj.id, entry);
    }
  }

  console.log(`${index + 1}/${total}: ${name} ✓`);
};

const processWithConcurrencyLimit = async (
  items,
  cb,
  maxConcurrent = 5
) => {
  const total = items.length;
  let remainingItems = [...items];
  let attempt = 0;
  const maxRetries = 10;

  while (remainingItems.length > 0 && attempt < maxRetries) {
    attempt++;
    const activePromises = new Set();
    const failedItems = [];
    let rateLimited = false;
    let retryAfter = 60000;

    for (let i = 0; i < remainingItems.length; i++) {
      const item = remainingItems[i];
      const originalIndex = items.indexOf(item);
      
      const promise = cb(item, originalIndex, total)
        .then(() => {
          // Success - item processed
        })
        .catch(error => {
          if (error.code === 'rate_limited') {
            rateLimited = true;
            retryAfter = getRetryAfter(error);
            failedItems.push(item);
            console.error(
              `⚠️  Rate limited for item ${originalIndex + 1} - ${
                item.properties.Name?.title[0]?.plain_text || 'No name'
              }`
            );
          } else {
            console.error(
              `Error processing item ${originalIndex + 1} - ${
                item.properties.Name?.title[0]?.plain_text || 'No name'
              }:`,
              error.message
            );
          }
        });

      activePromises.add(promise);

      promise.finally(() => activePromises.delete(promise));

      if (activePromises.size >= maxConcurrent) {
        await Promise.race(activePromises);
      }
    }

    await Promise.all(activePromises);

    if (rateLimited && failedItems.length > 0) {
      const waitSeconds = Math.ceil(retryAfter / 1000);
      console.log(`\n⏳ Rate limited. Waiting ${waitSeconds} seconds before retrying ${failedItems.length} items...`);
      await sleep(retryAfter);
      remainingItems = failedItems;
      console.log(`🔄 Retrying ${failedItems.length} items (attempt ${attempt + 1})...\n`);
    } else {
      remainingItems = [];
    }
  }

  if (remainingItems.length > 0) {
    console.error(`\n⚠️  Some items failed after ${maxRetries} retry attempts.`);
  }
};

const loadProgress = async () => {
  try {
    const progressData = JSON.parse(await readFile(PROGRESS_FILE, 'utf-8'));
    return new Set(progressData.processedIds || []);
  } catch {
    return new Set();
  }
};

const loadExistingCurriculumData = async () => {
  try {
    const existingData = JSON.parse(await readFile(JSON_FILE, 'utf-8'));
    return existingData || [];
  } catch {
    return [];
  }
};

const saveProgress = async (processedIds) => {
  await writeFile(PROGRESS_FILE, JSON.stringify({ processedIds: Array.from(processedIds) }, null, 2));
};

const downloadCurriculum = async (database, maxConcurrent = 5) => {
  const startTime = Date.now();
  console.log(`Starting egress with max concurrent operations: ${maxConcurrent}`);
  let itemsToProcess = [];
  const processedIds = await loadProgress();
  const existingCurriculumData = await loadExistingCurriculumData();
  
  const notionIdToEntryMap = new Map();
  const ftIdToEntryMap = new Map();
  existingCurriculumData.forEach(item => {
    if (item.notionId) {
      notionIdToEntryMap.set(item.notionId, item);
    }
    if (item['ft-id']) {
      ftIdToEntryMap.set(item['ft-id'], item);
    }
  });

  let db;
  try {
    db = JSON.parse(await readFile(`${database}.json`, 'utf-8'));
    console.log('Reading local file');
  } catch {
    console.log('Fetching from Notion...');
    db = await getCurriculumContent(database);
    const data = new Uint8Array(Buffer.from(JSON.stringify(db)));
    await writeFile(database + '.json', data);
  }

  itemsToProcess = itemsToProcess.concat(db);
  
  itemsToProcess.forEach(item => {
    if (processedIds.has(item.id)) {
      let existingEntry = null;
      if (notionIdToEntryMap.has(item.id)) {
        existingEntry = notionIdToEntryMap.get(item.id);
      } else {
        const metadata = extractPageMetadata(item);
        if (ftIdToEntryMap.has(metadata['ft-id'])) {
          existingEntry = ftIdToEntryMap.get(metadata['ft-id']);
        }
      }
      
      if (existingEntry && !curriculumDataMap.has(item.id)) {
        curriculumDataMap.set(item.id, existingEntry);
        curriculumData.push(existingEntry);
      }
    }
  });
  
  const itemsToSkip = itemsToProcess.filter(item => processedIds.has(item.id));
  const itemsToProcessNow = itemsToProcess.filter(item => !processedIds.has(item.id));

  if (itemsToSkip.length > 0) {
    console.log(`Skipping ${itemsToSkip.length} already processed items...`);
  }
  console.log(`Processing ${itemsToProcessNow.length} items...`);

  const writeMDFileWithProgress = async (notionObj, index, total) => {
    await writeMDFile(notionObj, index, total);
    processedIds.add(notionObj.id);
    await saveProgress(processedIds);
  };

  await processWithConcurrencyLimit(itemsToProcessNow, writeMDFileWithProgress, maxConcurrent);

  const uniqueCurriculumData = [];
  const seenFtIds = new Set();
  
  for (const item of curriculumData) {
    const ftId = item['ft-id'] || item.notionId || JSON.stringify(item);
    if (!seenFtIds.has(ftId)) {
      seenFtIds.add(ftId);
      uniqueCurriculumData.push(item);
    }
  }
  
  uniqueCurriculumData.sort((a, b) => a['ft-id'].localeCompare(b['ft-id']));
  await writeFile(JSON_FILE, JSON.stringify(uniqueCurriculumData, null, 2));
  console.log(`\nJSON file written to: ${JSON_FILE}`);

  await writeFile(PROGRESS_FILE, JSON.stringify({ processedIds: Array.from(processedIds) }, null, 2));

  const endTime = Date.now();
  const duration = (endTime - startTime) / 1000;

  console.log(`DONE! Processed ${itemsToProcess.length} items in ${duration.toFixed(2)} seconds`);
};

downloadCurriculum(database, 10);
