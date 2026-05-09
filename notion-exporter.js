import { Client } from '@notionhq/client';
import { NotionToMarkdown } from 'notion-to-md';
import * as fs from 'fs/promises';
import * as path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const n2m = new NotionToMarkdown(
	{
		notionClient: notion,
		config: {
			separateChildPage: true, // Export child pages separately
		},
	}
);

// Retry wrapper
async function withRetry(fn, retries = 3, waitMs = 2000) {
	for (let i = 0; i < retries; i++) {
		try {
			return await fn();
		} catch (e) {
			if (i === retries - 1) throw e;
			console.warn(`Retrying (${i + 1}/${retries}) after error: ${e.message}`);
			await new Promise((r) => setTimeout(r, waitMs));
		}
	}
}

// Export a single page
async function exportPage(pageId, title) {
	console.log(`📤 Exporting: ${title}`);

	// Use n2m.pageToMarkdown for full page conversion (handles recursion)
	const mdBlocksArr = await withRetry(() => n2m.pageToMarkdown(pageId, 3));

	if (!mdBlocksArr || mdBlocksArr.length === 0) {
		console.warn(`ℹ️  Skipping "${title}" because it has no content to export.`);
		return;
	}

	const mdStringObj = n2m.toMarkdownString(mdBlocksArr);
	const mdString = typeof mdStringObj === 'string' ? mdStringObj : mdStringObj.parent;

	if (!mdString) {
		console.warn(`⚠️  No markdown content was generated for "${title}". This page will be skipped and not saved as a file.`);
		return;
	}

	// Prepend the title as an H1 heading
	const mdWithTitle = `# ${title}\n\n${mdString}`;

	// Remove all leading indentation from each line
	const mdNoIndent = mdWithTitle
		.split('\n')
		.map(line => line.replace(/^[ \t]+/, ''))
		.join('\n');

	// Convert title to kebab case for filename
	const kebabTitle = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-') // Replace non-alphanumeric with hyphens
		.replace(/^-+|-+$/g, '');    // Trim leading/trailing hyphens

	const filePath = path.join('output', `${kebabTitle}.md`);
	await fs.mkdir('output', { recursive: true });
	await fs.writeFile(filePath, mdNoIndent);
	console.log(`✅ Saved to ${filePath}`);
}

// Helper to extract the title from a Notion page object
function getTitleFromPage(page) {
  // Notion page title is usually in the 'properties' object, find the first 'title' property
  if (!page.properties) return 'Untitled';
  for (const key in page.properties) {
    const prop = page.properties[key];
    if (prop.type === 'title' && Array.isArray(prop.title) && prop.title.length > 0) {
      // Concatenate all plain_text parts
      return prop.title.map(t => t.plain_text).join('') || 'Untitled';
    }
  }
  return 'Untitled';
}

// Get all top-level pages (or child pages if used inside a workspace)
async function getAllPages() {
  const pages = [];

  let cursor;
  let hasMore = true;

  while (hasMore) {
    const res = await withRetry(() =>
      notion.search({
        start_cursor: cursor,
        page_size: 100,
        filter: {
          value: 'page',
          property: 'object',
        },
      })
    );

    for (const result of res.results) {
      if (result.object === 'page') {
        pages.push({
          id: result.id,
          title: getTitleFromPage(result),
        });
      }
    }

    hasMore = res.has_more;
    cursor = res.next_cursor;
  }

  return pages;
}

// Main
async function exportAllPages() {
  const pages = await getAllPages();

  if (pages.length === 0) {
    console.warn('⚠️  No pages found. Make sure your Notion integration is connected to at least one page. Read the README.md for setup instructions.');
    return;
  }

  for (const page of pages) {
    try {
      await exportPage(page.id, page.title);
      await new Promise((r) => setTimeout(r, 2000)); // 2 seconds delay
    } catch (e) {
      console.error(`❌ Failed to export ${page.title}:`, e.message);
    }
  }
}

exportAllPages();