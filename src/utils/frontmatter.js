import { normalizeId } from './text.js';

export const generateFrontMatter = (notionObj) => {
  const { icon, properties } = notionObj;
  const name = properties.Name?.title.map((t) => t.plain_text).join('');
  const unit = properties.Unit?.select.name;
  const chapter = properties.Chapter?.select.name;

  const instructorNotes =
    properties['Instructor notes']?.rich_text.length > 0
      ? properties['Instructor notes']?.rich_text.map(t => t.plain_text)
      : null;

  const linksArr =
    properties['Instructor notes']?.rich_text.length > 0
      ? properties['Instructor notes']?.rich_text.map(t => t.href).filter(Boolean)
      : null;
  const instructorNotesLinks = linksArr?.length ? linksArr : null;

  const rawFtId = properties['ID FT']?.formula?.string || 'N/A';
  const rawPtId = properties['ID PT']?.formula?.string || 'N/A';
  const ftId = normalizeId(rawFtId);
  const ptId = normalizeId(rawPtId);

  return `---
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
};

export const extractPageMetadata = (notionObj) => {
  const { icon, properties } = notionObj;
  const name = properties.Name?.title.map((t) => t.plain_text).join('');
  const unit = properties.Unit?.select.name;
  const chapter = properties.Chapter?.select.name;

  const rawFtId = properties['ID FT']?.formula?.string || 'N/A';
  const rawPtId = properties['ID PT']?.formula?.string || 'N/A';
  const ftId = normalizeId(rawFtId);
  const ptId = normalizeId(rawPtId);

  return {
    notionId: notionObj.id,
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
    'pt-id': ptId
  };
};
