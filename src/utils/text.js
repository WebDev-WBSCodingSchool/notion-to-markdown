import slugify from 'slugify';

export const normalizeId = (id) => {
  if (!id || id === 'N/A') return 'NA';
  return id.trim().endsWith('.') ? 'NA' : id;
};

export const cleanForSlug = (text) => {
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

export const slugifyPath = (unit, chapter, name) => {
  const cleanUnit = slugify(cleanForSlug(unit), { lower: true });
  const cleanChapter = slugify(cleanForSlug(chapter), { lower: true });
  const cleanName = slugify(cleanForSlug(name), { lower: true });
  return `${cleanUnit}/${cleanChapter}/${cleanName}`;
};
