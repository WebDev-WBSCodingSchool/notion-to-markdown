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
const curriculumData = [];

const notion = new Client({
  auth: notionSecret
});

const n2m = setupMarkdownTransformer(notion);

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

  const slugifiedPath = slugifyPath(unit, chapter, name);
  const fileLocation = `${slugifiedPath}.md`;
  const filepath = path.join(targetDir, fileLocation);
  const fileDir = path.dirname(filepath);
  
  await mkdir(fileDir, { recursive: true });
  
  const processedContent = await processImagesInMarkdown(parent, fileDir, filepath, targetDir, repoUrl, notionSecret);
  const data = new Uint8Array(Buffer.from(frontMatter.concat(processedContent)));
  await writeFile(filepath, data);

  const childPages = await getChildPages(notionObj.id);
  if (childPages.length > 0) {
    const solutionPage = childPages[0];
    const solutionMdBlocks = await n2m.pageToMarkdown(solutionPage.id);
    const { parent: solutionContent } = n2m.toMarkdownString(solutionMdBlocks);
    
    const solutionFileLocation = `solutions/${slugifiedPath}.md`;
    const solutionFilepath = path.join(targetDir, solutionFileLocation);
    const solutionFileDir = path.dirname(solutionFilepath);
    
    await mkdir(solutionFileDir, { recursive: true });
    
    const processedSolutionContent = await processImagesInMarkdown(solutionContent, solutionFileDir, solutionFilepath, targetDir, repoUrl, notionSecret);
    const solutionData = new Uint8Array(Buffer.from(frontMatter.concat(processedSolutionContent)));
    await writeFile(solutionFilepath, solutionData);
    
    console.log(`  └─ Solution saved: ${solutionFileLocation}`);
  }

  const metadata = extractPageMetadata(notionObj);
  curriculumData.push({
    ...metadata,
    repo_path: fileLocation
  });

  console.log(`${index + 1}/${total}: ${name} ✓`);
};

const processWithConcurrencyLimit = async (
  items,
  cb,
  maxConcurrent = 5
) => {
  const total = items.length;
  const activePromises = new Set();

  for (let i = 0; i < items.length; i++) {
    const promise = cb(items[i], i, total).catch(error => {
      console.error(
        `Error processing item ${i + 1} - ${
          items[i].properties.Name?.title[0]?.plain_text || 'No name'
        }:`,
        error
      );
    });

    activePromises.add(promise);

    promise.finally(() => activePromises.delete(promise));

    if (activePromises.size >= maxConcurrent) {
      await Promise.race(activePromises);
    }
  }

  await Promise.all(activePromises);
};

const downloadCurriculum = async (database, maxConcurrent = 5) => {
  const startTime = Date.now();
  console.log(`Starting egress with max concurrent operations: ${maxConcurrent}`);
  let itemsToProcess = [];

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

  console.log(`Processing ${itemsToProcess.length} items...`);

  await processWithConcurrencyLimit(itemsToProcess, writeMDFile, maxConcurrent);

  curriculumData.sort((a, b) => a['ft-id'].localeCompare(b['ft-id']));
  await writeFile(JSON_FILE, JSON.stringify(curriculumData, null, 2));
  console.log(`\nJSON file written to: ${JSON_FILE}`);

  const endTime = Date.now();
  const duration = (endTime - startTime) / 1000;

  console.log(`DONE! Processed ${itemsToProcess.length} items in ${duration.toFixed(2)} seconds`);
};

downloadCurriculum(database);
