import { Client } from '@notionhq/client';

export const getPageMetadata = async (itemId) => {
  const notion = new Client({
    auth: process.env.NOTION_SECRET,
  });
  return await notion.pages.retrieve({ page_id: itemId });
};

export const getPageContent = async (blockId) => {
  const notion = new Client({
    auth: process.env.NOTION_SECRET,
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
      start_cursor: next_cursor,
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

export const getCurriculumContent = async (database_id) => {
  const notion = new Client({
    auth: process.env.NOTION_SECRET,
  });
  let next_cursor = null;
  const curriculumDatabase = [];
  // Fetching the initial data
  const initialNotionRequest = await notion.databases.query({
    database_id,
    sorts: [{ property: 'Unit', direction: 'ascending' }],
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
      sorts: [{ property: 'Unit', direction: 'ascending' }],
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

export const mapDayToDaySchedule = (curriculum, isPartTime) => {
  const dayToDaySchedule = {};
  curriculum.forEach((page) => {
    const weekMatch = page.properties.Unit.select.name.match(/^(\d+)/);
    const weekNumber = weekMatch ? parseInt(weekMatch[1], 10) : null;
    let day;
    let seqNumber;
    if (isPartTime) {
      day = page.properties['DoW PT']?.select?.name || 'NA';
      seqNumber = page.properties.SeqPT.rich_text[0]?.plain_text || 'NA';
    } else {
      day = page.properties['DoW FT']?.select?.name || 'NA';
      seqNumber = page.properties.SeqFT.rich_text[0]?.plain_text || 'NA';
    }
    if (weekNumber !== null) {
      if (day === 'NA') return;
      const key = `Week ${weekNumber} ${day}`;
      if (!dayToDaySchedule[key]) {
        dayToDaySchedule[key] = [];
      }
      dayToDaySchedule[key].push({
        name: page.properties.Name.title[0].plain_text,
        color: page.properties['Content Type'].select.color,
        emoji: page.icon ? page.icon.emoji : '⛓️‍💥',
        seq: parseInt(seqNumber, 10),
        id: page.id,
      });
    }
  });
  Object.keys(dayToDaySchedule).forEach((key) => {
    dayToDaySchedule[key].sort((a, b) => a.seq - b.seq);
  });
  return dayToDaySchedule;
};

export const getDaysWithTasks = async (databaseId, isPartTime, dateRange, holidays, break1Days, break2Days) => {
  const curriculumDatabase = await getCurriculumContent(databaseId);
  // Map the curriculum to a day-to-day schedule
  const dayToDaySchedule = mapDayToDaySchedule(curriculumDatabase, isPartTime);
  // Create the tasks array
  let weekdayCount = 0;
  const daysWithTasks = dateRange.days().map((d) => {
    if (isPartTime) {
      if (
        d.day === 'Tuesday' ||
        d.day === 'Friday' ||
        d.day === 'Sunday' ||
        holidays.includes(d.label) ||
        break1Days.includes(d.label) ||
        break2Days.includes(d.label)
      ) {
        return { ...d, tasks: [] }; // No tasks assigned on these days
      }
    } else {
      if (
        d.day === 'Saturday' ||
        d.day === 'Sunday' ||
        holidays.includes(d.label) ||
        break1Days.includes(d.label) ||
        break2Days.includes(d.label)
      ) {
        return { ...d, tasks: [] }; // No tasks assigned on weekends or in holidays
      }
    }
    weekdayCount++;
    const currentWeek = isPartTime ? Math.floor((weekdayCount - 1) / 8) + 3 : Math.floor((weekdayCount - 1) / 5) + 1;
    const dayWithinWeek = isPartTime ? `Day ${((weekdayCount - 1) % 8) + 1}` : `Day ${((weekdayCount - 1) % 5) + 1}`;
    const dayKey = `Week ${currentWeek} ${dayWithinWeek}`;
    const courseItemsForDay = dayToDaySchedule[dayKey] || [];
    return { ...d, tasks: courseItemsForDay };
  });
  return daysWithTasks;
};
