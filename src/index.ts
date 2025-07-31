import { Buffer } from 'node:buffer';
import { writeFile, access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@notionhq/client';
import { NotionToMarkdown } from 'notion-to-md';
import { getCurriculumContent } from './utils/notionDatabase.js';

const notionSecret = process.env.NOTION_SECRET;
const database_id = process.env.DATABASE_ID;
if (!notionSecret) {
  console.log('NOTION_SECRET missing in environment');
  process.exit(1);
}
if (!database_id) {
  console.log('DATABASE_ID missing in environment');
  process.exit(1);
}

const notion = new Client({
  auth: notionSecret,
});

const n2m = new NotionToMarkdown({ notionClient: notion });
n2m.setCustomTransformer('embed', async (block) => {
  const { embed } = block as any;
  if (!embed?.url) return '';
  return `<figure>
  <iframe src="${embed?.url}"></iframe>
  <figcaption>${await n2m.blockToMarkdown(embed?.caption)}</figcaption>
</figure>`;
});

async function writeMDFile(notionObj: any, index: number, total: number): Promise<void> {
  const { icon, url, properties } = notionObj;

  const track = properties.Track.select.name;
  const chapter = properties.Chapter?.select.name || 'No chapter';
  const unit = properties.Unit?.select.name || 'No unit';
  const name = properties.Name?.title[0]?.plain_text || 'No name';

  const frontMatter = `---
icon:
  type: ${icon.type}
  emoji: ${icon.emoji}
url: ${url}
properties:
  name: ${name.replaceAll(':', '—')}
  chapter: ${chapter.replaceAll(':', '—')}
  chapterColor: ${properties.Chapter?.select.color || 'neutral'}
  objectives: ${properties.Objectives?.rich_text[0]?.plain_text || 'No objectives'}
  type: ${properties['Content Type']?.select.name || 'No type'}
  typeColor: ${properties['Content Type']?.select.color || 'neutral'}
  slides: ${properties.Slides?.rich_text[0]?.plain_text || null}
  unit: ${unit.replaceAll(':', '—')}
  unitColor: ${properties.Unit?.select.color || 'neutral'}
---
`;

  const mdBlocks = await n2m.pageToMarkdown(notionObj.id);
  const { parent } = n2m.toMarkdownString(mdBlocks);

  const dirpath = path.join(
    import.meta.dirname,
    '..',
    '..',
    'curriculum',
    track.replaceAll('/', '-').replaceAll(':', '—'),
    unit.replaceAll('/', '-').replaceAll(':', '—'),
    chapter.replaceAll('/', '-').replaceAll(':', '—')
  );
  try {
    await access(dirpath);
  } catch {
    await mkdir(dirpath, { recursive: true });
  }
  const filepath = path.join(dirpath, name.replaceAll('/', '-').replaceAll(':', '—') + '.md');
  const data = new Uint8Array(Buffer.from(frontMatter.concat(parent)));
  await writeFile(filepath, data);

  console.log(`${index + 1}/${total}: ${name} ✓`);
}

async function processWithConcurrencyLimit(
  items: any[],
  cb: (item: any, index: number, total: number) => Promise<void>,
  maxConcurrent: number = 5
): Promise<void> {
  const total = items.length;
  const activePromises = new Set<Promise<void>>();

  for (let i = 0; i < items.length; i++) {
    // Create the processing promise
    const promise = cb(items[i], i, total).catch((error) => {
      console.error(
        `Error processing item ${i + 1} - ${items[i].properties.Name?.title[0]?.plain_text || 'No name'}:`,
        error
      );
    });

    // Add to active promises set
    activePromises.add(promise);

    // Remove from set when done
    promise.finally(() => activePromises.delete(promise));

    // If we've hit our concurrency limit, wait for at least one to complete
    if (activePromises.size >= maxConcurrent) {
      await Promise.race(activePromises);
    }
  }

  // Wait for all remaining promises to complete
  await Promise.all(activePromises);
}

async function egressNotion(database_id: string, start = 1, end?: number, maxConcurrent = 8) {
  console.log(`Starting egress with max concurrent operations: ${maxConcurrent}`);

  const db = await getCurriculumContent(database_id);
  const loopStart = start - 1;
  const loopEnd = end ?? db.length;

  const itemsToProcess = db.slice(loopStart, loopEnd);

  console.log(`Processing ${itemsToProcess.length} items...`);

  const startTime = Date.now();

  await processWithConcurrencyLimit(
    itemsToProcess,
    async (notionObj, index, total) => {
      await writeMDFile(notionObj, loopStart + index, db.length);
    },
    maxConcurrent
  );

  const endTime = Date.now();
  const duration = (endTime - startTime) / 1000;

  console.log(`DONE! Processed ${itemsToProcess.length} items in ${duration.toFixed(2)} seconds`);
}

egressNotion(database_id);
