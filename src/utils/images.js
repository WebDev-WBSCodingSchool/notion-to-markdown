import { mkdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import slugify from 'slugify';

export const downloadImage = async (url, filepath, authToken) => {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = createWriteStream(filepath);
    
    const isS3Url = url.includes('s3.') || url.includes('amazonaws.com');
    const headers = {};
    
    if (!isS3Url) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }
    
    protocol.get(url, { headers }, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        return downloadImage(response.headers.location, filepath, authToken).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) {
        file.close();
        reject(new Error(`Failed to download image: ${response.statusCode}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      file.close();
      reject(err);
    });
  });
};

export const processImagesInMarkdown = async (
  content,
  fileDir,
  markdownFilePath,
  repoRoot,
  repoUrl,
  authToken
) => {
  const imagesDir = path.join(fileDir, 'images');
  await mkdir(imagesDir, { recursive: true });
  
  let processedContent = content;
  const imageUrlRegex = /!\[([^\]]*)\]\((https:\/\/[^)]+)\)/g;
  const imageMatches = [...content.matchAll(imageUrlRegex)];
  
  for (const match of imageMatches) {
    const [fullMatch, altText, imageUrl] = match;
    
    try {
      const urlObj = new URL(imageUrl);
      const pathname = urlObj.pathname;
      let filename = pathname.split('/').pop() || `image-${Date.now()}.png`;
      filename = filename.split('?')[0];
      
      const fileExtension = path.extname(filename) || '.png';
      const baseName = path.basename(filename, fileExtension);
      const sanitizedBaseName = slugify(baseName, { lower: true, strict: true });
      const sanitizedFilename = `${sanitizedBaseName}${fileExtension}`;
      
      const imagePath = path.join(imagesDir, sanitizedFilename);
      const imagePathRelativeToRepo = path.relative(repoRoot, imagePath);
      const imagePathForMarkdown = imagePathRelativeToRepo.split(path.sep).join('/');
      
      await downloadImage(imageUrl, imagePath, authToken);
      
      const fullImageUrl = `${repoUrl}/${imagePathForMarkdown}`;
      
      processedContent = processedContent.replace(
        fullMatch,
        `![${altText}](${fullImageUrl})`
      );
    } catch (error) {
      console.error(`Failed to download image ${imageUrl}:`, error);
    }
  }
  
  return processedContent;
};
