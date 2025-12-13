import { Buffer } from 'node:buffer';
import { writeFile, mkdir, appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@notionhq/client';
import { NotionToMarkdown } from 'notion-to-md';
import slugify from 'slugify';
import { getCurriculumContent } from './utils/notionDatabase.js';

const notionSecret = process.env.NOTION_SECRET;
const database = process.argv[2];
const targetDir = process.argv[3];

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
const curriculumData: any[] = [];

// Helper function to normalize ft-id and pt-id
// If the ID ends with a dot, return "NA", otherwise return the ID
const normalizeId = (id: string | undefined): string => {
  if (!id || id === 'N/A') return 'NA';
  return id.trim().endsWith('.') ? 'NA' : id;
};

const notion = new Client({
  auth: notionSecret
});

const n2m = new NotionToMarkdown({ notionClient: notion });
n2m.setCustomTransformer('embed', async block => {
  const { embed } = block as any;
  if (!embed?.url) return '';
  return `<figure>
  <iframe title="WBS Coding Playground" width="100%" height="600" scrolling="no" allowfullscreen src="${
    embed?.url
  }"></iframe>
  <figcaption>${await n2m.blockToMarkdown(embed?.caption)}</figcaption>
</figure>`;
});

const writeMDFile = async (notionObj: any, index: number, total: number): Promise<void> => {
  const { icon, properties } = notionObj;

  const unit = properties.Unit?.select.name;
  const chapter = properties.Chapter?.select.name;
  const name = properties.Name?.title.map((t: any) => t.plain_text).join('');

  if (!unit || !chapter || !name) {
    console.error(`Missing required properties for page ID ${notionObj.id}. Skipping.`);
    return;
  }

  const instructorNotes =
    properties['Instructor notes']?.rich_text.length > 0
      ? properties['Instructor notes']?.rich_text.map(t => t.plain_text)
      : null;

  const linksArr =
    properties['Instructor notes']?.rich_text.length > 0
      ? properties['Instructor notes']?.rich_text.map(t => t.href).filter(Boolean)
      : null;
  const instructorNotesLinks = linksArr?.length ? linksArr : null;

  // Get IDs and normalize them
  const rawFtId = properties['ID FT']?.formula?.string || 'N/A';
  const rawPtId = properties['ID PT']?.formula?.string || 'N/A';
  const ftId = normalizeId(rawFtId);
  const ptId = normalizeId(rawPtId);

  const frontMatter = `---
  icon: ${icon.emoji}
  title: ${name.replaceAll(':', '—')}
  unit: 
    name: ${unit.replaceAll(':', '—')}
    color: ${properties.Unit?.select.color || 'neutral'}
  chapter: 
    name: ${chapter.replaceAll(':', '—')}
    color: ${properties.Chapter?.select.color || 'neutral'}
  type: 
    name: ${properties['Content Type']?.select.name || 'No type'}
    color: ${properties['Content Type']?.select.color || 'neutral'}
  ft-id: ${ftId}
  pt-id: ${ptId}
  objectives: ${properties.Objectives?.rich_text[0]?.plain_text || 'No objectives'}
  slides: ${properties.Slides?.rich_text[0]?.plain_text || null}
  instructorNotes:
    plainText: ${instructorNotes}
    links: ${instructorNotesLinks}
---
`;

  const mdBlocks = await n2m.pageToMarkdown(notionObj.id);
  const { parent } = n2m.toMarkdownString(mdBlocks);

  // Helper to clean special characters before slugifying
  const cleanForSlug = (text: string): string => {
    return text
      .replaceAll('/', '-')
      .replaceAll('(', '')
      .replaceAll(')', '')
      .replaceAll(',', '')
      .replaceAll(':', '-')
      .replaceAll('+', '-')
      .replaceAll('?', '')
      .replaceAll('!', '')
      .trim();
  };

  // Clean and slugify each part separately
  const cleanUnit = slugify(cleanForSlug(unit), { lower: true });
  const cleanChapter = slugify(cleanForSlug(chapter), { lower: true });
  const cleanName = slugify(cleanForSlug(name), { lower: true });
  
  const fileLocation = `${cleanUnit}/${cleanChapter}/${cleanName}.md`;

  const filepath = path.join(targetDir, fileLocation);
  const data = new Uint8Array(Buffer.from(frontMatter.concat(parent)));

  // Ensure the directory for this file exists
  const fileDir = path.dirname(filepath);
  await mkdir(fileDir, { recursive: true });
  await writeFile(filepath, data);

  // Create JSON item with all required metadata (excluding objectives, slides, instructorNotes)
  curriculumData.push({
    icon: icon.emoji,
    title: name.replaceAll(':', '—'),
    unit: {
      name: unit.replaceAll(':', '—'),
      color: properties.Unit?.select.color || 'neutral'
    },
    chapter: {
      name: chapter.replaceAll(':', '—'),
      color: properties.Chapter?.select.color || 'neutral'
    },
    type: {
      name: properties['Content Type']?.select.name || 'No type',
      color: properties['Content Type']?.select.color || 'neutral'
    },
    'ft-id': ftId,
    'pt-id': ptId,
    repo_path: fileLocation
  });

  console.log(`${index + 1}/${total}: ${name} ✓`);
};

const processWithConcurrencyLimit = async (
  items: any[],
  cb: (item: any, index: number, total: number) => Promise<void>,
  maxConcurrent: number = 5
): Promise<void> => {
  const total = items.length;
  const activePromises = new Set<Promise<void>>();

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

const downloadCurriculum = async (database: string, maxConcurrent = 5) => {
  const startTime = Date.now();
  console.log(`Starting egress with max concurrent operations: ${maxConcurrent}`);
  let itemsToProcess: any[] = [];

  let db: any;
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
