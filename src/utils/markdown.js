import { NotionToMarkdown } from 'notion-to-md';

export const setupMarkdownTransformer = (notionClient) => {
  const n2m = new NotionToMarkdown({ notionClient });
  
  n2m.setCustomTransformer('embed', async block => {
    const { embed } = block;
    if (!embed?.url) return '';
    return `<figure>
  <iframe title="WBS Coding Playground" width="100%" height="600" scrolling="no" allowfullscreen src="${
    embed?.url
  }"></iframe>
  <figcaption>${await n2m.blockToMarkdown(embed?.caption)}</figcaption>
</figure>`;
  });

  n2m.setCustomTransformer('child_page', async () => {
    return '';
  });

  return n2m;
};
