import { Client } from '@notionhq/client';

export const getPageMetadata = async itemId => {
  const notion = new Client({
    auth: process.env.NOTION_SECRET
  });
  return await notion.pages.retrieve({ page_id: itemId });
};

export const getPageContent = async blockId => {
  const notion = new Client({
    auth: process.env.NOTION_SECRET
  });
  let next_cursor = null;
  const content = [];
  const blocks = await notion.blocks.children.list({ block_id: blockId });
  content.push(...blocks.results);
  if (blocks.has_more) {
    next_cursor = blocks.next_cursor;
  }
  while (next_cursor) {
    const moreBlocks = await notion.blocks.children.list({
      block_id: blockId,
      page_size: 50,
      start_cursor: next_cursor
    });
    content.push(...moreBlocks.results);
    if (moreBlocks.has_more) {
      next_cursor = moreBlocks.next_cursor;
    } else {
      next_cursor = null;
      break;
    }
  }
  for (const block of blocks.results) {
    if (block.has_children) {
      const children = await getPageContent(block.id);
      block.children = children;
    }
    if (block.synced_block?.synced_from?.block_id) {
      const syncedBlock = await getPageContent(block.synced_block.synced_from.block_id);
      block.synced_block.synced_from.children = syncedBlock;
    }
  }
  return content;
};

export const getCurriculumContent = async database_id => {
  const notion = new Client({
    auth: process.env.NOTION_SECRET
  });
  let next_cursor = null;
  const curriculumDatabase = [];
  // Fetching the initial data
  const initialNotionRequest = await notion.databases.query({
    database_id,
    sorts: [{ property: 'Unit', direction: 'ascending' }]
  });
  curriculumDatabase.push(...initialNotionRequest.results);
  // If there are more pages, set the cursor
  if (initialNotionRequest.has_more) {
    next_cursor = initialNotionRequest.next_cursor;
  }
  // Fetching the rest of the data
  while (next_cursor) {
    const notionResponse = await notion.databases.query({
      database_id,
      start_cursor: next_cursor,
      sorts: [{ property: 'Unit', direction: 'ascending' }]
    });
    curriculumDatabase.push(...notionResponse.results);
    if (notionResponse.has_more) {
      next_cursor = notionResponse.next_cursor;
    } else {
      next_cursor = null;
      break;
    }
  }
  return curriculumDatabase;
};

// Recursively get all blocks from a page/block, including nested blocks
const getAllBlocks = async (blockId, notion) => {
  let next_cursor = null;
  const allBlocks = [];
  
  const blocks = await notion.blocks.children.list({ block_id: blockId });
  allBlocks.push(...blocks.results);
  
  if (blocks.has_more) {
    next_cursor = blocks.next_cursor;
  }
  
  while (next_cursor) {
    const moreBlocks = await notion.blocks.children.list({
      block_id: blockId,
      page_size: 100,
      start_cursor: next_cursor
    });
    allBlocks.push(...moreBlocks.results);
    
    if (moreBlocks.has_more) {
      next_cursor = moreBlocks.next_cursor;
    } else {
      next_cursor = null;
    }
  }
  
  // Recursively check blocks that have children
  for (const block of allBlocks) {
    if (block.has_children) {
      const nestedBlocks = await getAllBlocks(block.id, notion);
      allBlocks.push(...nestedBlocks);
    }
    
    // Check synced blocks - get content from the original synced block
    if ('type' in block && block.type === 'synced_block' && block.synced_block?.synced_from?.block_id) {
      const syncedBlocks = await getAllBlocks(block.synced_block.synced_from.block_id, notion);
      allBlocks.push(...syncedBlocks);
    }
  }
  
  return allBlocks;
};

// Get child pages (solutions) from a parent page
export const getChildPages = async pageId => {
  const notion = new Client({
    auth: process.env.NOTION_SECRET
  });
  try {
    const childPages = [];
    
    // Get all blocks recursively, including nested and synced blocks
    const allBlocks = await getAllBlocks(pageId, notion);
    
    // Filter for child_page blocks
    for (const block of allBlocks) {
      if ('type' in block && block.type === 'child_page') {
        // Retrieve the full page data
        const childPage = await notion.pages.retrieve({ page_id: block.id });
        childPages.push(childPage);
      }
    }
    
    return childPages;
  } catch (error) {
    console.error(`Error fetching child pages for ${pageId}:`, error);
    return [];
  }
};
