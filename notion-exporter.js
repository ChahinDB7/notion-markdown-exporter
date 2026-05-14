import { Client } from '@notionhq/client';
import { NotionToMarkdown } from 'notion-to-md';
import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { multiSelect, singleSelect, promptText, promptConfirm, BACK } from './lib/tui-picker.js';

dotenv.config({ quiet: true });

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const n2m = new NotionToMarkdown({
	notionClient: notion,
	config: {
		separateChildPage: true, // Export child pages separately
	},
});

// ---------- retry ----------

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

// ---------- helpers ----------

function getTitleFromPage(page) {
	if (!page.properties) return 'Untitled';
	for (const key in page.properties) {
		const prop = page.properties[key];
		if (prop.type === 'title' && Array.isArray(prop.title) && prop.title.length > 0) {
			return prop.title.map((t) => t.plain_text).join('') || 'Untitled';
		}
	}
	return 'Untitled';
}

function iconToText(icon) {
	if (!icon) return '';
	if (icon.type === 'emoji' && icon.emoji) return icon.emoji;
	if (icon.type === 'external' || icon.type === 'file') return '🖼️';
	return '';
}

// ---------- listing + tree ordering ----------

async function getAllPages() {
	const raw = [];
	let cursor;
	let hasMore = true;
	while (hasMore) {
		const res = await withRetry(() =>
			notion.search({
				start_cursor: cursor,
				page_size: 100,
				filter: { value: 'page', property: 'object' },
			})
		);
		for (const r of res.results) {
			if (r.object === 'page') {
				raw.push({
					id: r.id,
					title: getTitleFromPage(r),
					parent: r.parent,
					icon: iconToText(r.icon),
				});
			}
		}
		hasMore = res.has_more;
		cursor = res.next_cursor;
	}
	return orderPagesAsTree(raw);
}

// Same ordering rule as notion-patcher.js: parent->children map from accessible
// pages, sort each level alphabetically (numeric-aware), depth-first walk.
function orderPagesAsTree(rawPages) {
	const accessible = new Set(rawPages.map((p) => p.id));
	const childrenOf = new Map();
	const roots = [];
	for (const p of rawPages) {
		const parentId =
			p.parent?.type === 'page_id' && accessible.has(p.parent.page_id)
				? p.parent.page_id
				: null;
		if (parentId) {
			if (!childrenOf.has(parentId)) childrenOf.set(parentId, []);
			childrenOf.get(parentId).push(p);
		} else {
			roots.push(p);
		}
	}
	const cmp = (a, b) =>
		a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' });
	roots.sort(cmp);
	for (const arr of childrenOf.values()) arr.sort(cmp);

	const out = [];
	function walk(siblings, parentLasts) {
		for (let i = 0; i < siblings.length; i++) {
			const isLast = i === siblings.length - 1;
			const page = siblings[i];
			out.push({
				...page,
				_tree: { depth: parentLasts.length, isLast, parentLasts: [...parentLasts] },
			});
			const kids = childrenOf.get(page.id) || [];
			walk(kids, [...parentLasts, isLast]);
		}
	}
	walk(roots, []);
	return { pages: out, childrenOf };
}

function pageTreePrefix(page) {
	const t = page._tree;
	if (!t || t.depth === 0) return '';
	let s = '';
	for (const wasLast of t.parentLasts) s += wasLast ? '    ' : '│   ';
	s += t.isLast ? '└── ' : '├── ';
	return s;
}

// ---------- descendants for the multi-select cascade ----------

// id -> [descendant ids]; toggling a parent in the picker propagates the
// new state down to every descendant.
function buildDescendantsMap(pages, childrenOf) {
	const descendantsOf = new Map();
	function gather(id) {
		if (descendantsOf.has(id)) return descendantsOf.get(id);
		const out = [];
		const kids = childrenOf.get(id) || [];
		for (const k of kids) {
			out.push(k.id);
			out.push(...gather(k.id));
		}
		descendantsOf.set(id, out);
		return out;
	}
	for (const p of pages) gather(p.id);
	return descendantsOf;
}

// ---------- folder name validation ----------

// Reject anything that's not a safe single-segment folder name on
// Windows/macOS/Linux. Windows is the strictest, so a Windows-safe name is
// safe everywhere.
function validateFolderName(name) {
	if (typeof name !== 'string' || name.length === 0)
		return 'Folder name cannot be empty.';
	if (name.length > 255) return 'Folder name is too long (max 255 characters).';
	if (name === '.' || name === '..') return 'Folder name cannot be "." or "..".';
	if (/[<>:"/\\|?*]/.test(name))
		return 'Folder name cannot contain any of these characters: < > : " / \\ | ? *';
	if (/[\x00-\x1f]/.test(name))
		return 'Folder name cannot contain control characters.';
	if (/[ .]$/.test(name))
		return 'Folder name cannot end with a space or a period (Windows restriction).';
	if (/^\s/.test(name)) return 'Folder name cannot start with whitespace.';
	const winReserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;
	if (winReserved.test(name))
		return `"${name}" is a reserved device name on Windows (CON, PRN, AUX, NUL, COM1-9, LPT1-9).`;
	return null;
}

// ---------- existing output folders ----------

// Walk the project for folders that already contain at least one .md file
// (excluding README.md and common build dirs). The exporter offers these
// as quick-pick destinations so re-exports drop into the same folder.
const FOLDER_IGNORE_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'out']);
const FOLDER_IGNORE_FILES = new Set(['README.md']);
async function findFoldersWithMd(rootDir = '.') {
	const counts = new Map();
	async function walk(dir) {
		let entries;
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		let mdCount = 0;
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (entry.name.startsWith('.')) continue;
				if (FOLDER_IGNORE_DIRS.has(entry.name)) continue;
				await walk(path.join(dir, entry.name));
			} else if (entry.isFile() && entry.name.endsWith('.md')) {
				if (FOLDER_IGNORE_FILES.has(entry.name)) continue;
				mdCount++;
			}
		}
		if (mdCount > 0) {
			const rel = path.relative(rootDir, dir) || '.';
			counts.set(rel, mdCount);
		}
	}
	await walk(rootDir);
	return counts;
}

// ---------- export ----------

async function exportPage(pageId, title, outDir) {
	console.log(`📤 Exporting: ${title}`);

	const mdBlocksArr = await withRetry(() => n2m.pageToMarkdown(pageId, 3));

	if (!mdBlocksArr || mdBlocksArr.length === 0) {
		console.warn(`ℹ️  Skipping "${title}" because it has no content to export.`);
		return;
	}

	const mdStringObj = n2m.toMarkdownString(mdBlocksArr);
	const mdString = typeof mdStringObj === 'string' ? mdStringObj : mdStringObj.parent;

	if (!mdString) {
		console.warn(
			`⚠️  No markdown content was generated for "${title}". This page will be skipped and not saved as a file.`
		);
		return;
	}

	const mdWithTitle = `# ${title}\n\n${mdString}`;
	const mdNoIndent = mdWithTitle
		.split('\n')
		.map((line) => line.replace(/^[ \t]+/, ''))
		.join('\n');

	const kebabTitle = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');

	const filePath = path.join(outDir, `${kebabTitle}.md`);
	await fs.mkdir(outDir, { recursive: true });
	await fs.writeFile(filePath, mdNoIndent);
	console.log(`✅ Saved to ${filePath}\n\n`);
}

async function main() {
	if (!process.env.NOTION_API_KEY) {
		console.error('❌ NOTION_API_KEY is not set. See README.md.');
		process.exit(1);
	}

	const { pages, childrenOf } = await getAllPages();

	if (pages.length === 0) {
		console.warn(
			'⚠️  No pages found. Make sure your Notion integration is connected to at least one page. Read the README.md for setup instructions.'
		);
		return;
	}

	const descendantsOf = buildDescendantsMap(pages, childrenOf);
	const existingFolders = await findFoldersWithMd('.');

	// "output" is always offered as the first option, even when the folder
	// doesn't exist yet — exportPage() creates it on the first write.
	// "Enter folder name yourself…" sits at slot 2; the rest are folders
	// that already contain .md files, alphabetical, with "output" and the
	// project root deduped out.
	const CUSTOM_SENTINEL = { __custom: true };
	const buildFolderOptions = () => {
		const opts = [
			{ folder: 'output', count: existingFolders.get('output') || 0 },
			CUSTOM_SENTINEL,
		];
		const others = [...existingFolders.keys()]
			.filter((f) => f !== 'output' && f !== '.')
			.sort();
		for (const f of others) {
			opts.push({ folder: f, count: existingFolders.get(f) });
		}
		return opts;
	};
	const renderFolderOption = (o) => {
		if (o === CUSTOM_SENTINEL) return '✏️  Enter folder name yourself…';
		const label = `${o.folder}/`;
		if (o.count > 0) return `📁 ${label}  (${o.count} file${o.count === 1 ? '' : 's'})`;
		return `📁 ${label}  (new — will be created)`;
	};

	// ---- interactive flow with Esc-back navigation ----
	// State machine: pages → pick_output_folder → [enter_custom_folder] → done.
	// Esc on a state returns to the previous one with prior input rehydrated.
	// Esc on the first step (`pages`) is ignored.
	let state = 'pages';
	let selectedIds = null; // Set<id> of pages picked in the multi-select
	let pickFolderIndex = 0; // cursor position in the folder picker
	let outDirDraft = ''; // text typed so far in the custom-folder prompt
	let outDir = null;

	while (state !== 'done') {
		if (state === 'pages') {
			selectedIds = await multiSelect({
				header: 'Which pages should I export?',
				items: pages,
				renderItem: (p) => (p.icon ? `${p.icon} ` : '') + p.title,
				prefix: pageTreePrefix,
				keyFn: (p) => p.id,
				cascadeFn: (p) => (descendantsOf.get(p.id) || []).map((id) => ({ id })),
				initialChecked: selectedIds || undefined,
				allowBack: false,
			});
			console.log(`✅ ${selectedIds.size} page(s) selected.`);
			state = 'pick_output_folder';
			continue;
		}
		if (state === 'pick_output_folder') {
			const opts = buildFolderOptions();
			const result = await singleSelect({
				header: 'Which folder should the .md files go to?',
				items: opts,
				renderItem: renderFolderOption,
				allowBack: true,
				initialIndex: pickFolderIndex,
			});
			if (result === BACK) {
				state = 'pages';
				continue;
			}
			pickFolderIndex = opts.indexOf(result);
			if (result === CUSTOM_SENTINEL) {
				state = 'enter_custom_folder';
				continue;
			}
			outDir = result.folder;
			state = 'done';
			continue;
		}
		if (state === 'enter_custom_folder') {
			const result = await promptText({
				message: 'Enter a folder name:',
				defaultValue: 'output',
				validate: validateFolderName,
				allowBack: true,
				initialValue: outDirDraft,
				// Matches validateFolderName's 255-char cap (Windows path-component limit).
				maxLength: 200,
			});
			if (result === BACK) {
				state = 'pick_output_folder';
				continue;
			}
			outDir = result;
			outDirDraft = result;
			state = 'done';
		}
	}

	console.log(`\n📁 Output folder: ${outDir}`);
	console.log(`📤 Exporting ${selectedIds.size} page(s)…\n`);

	// Walk in tree order so output console messages match the picker order.
	for (const page of pages) {
		if (!selectedIds.has(page.id)) continue;
		try {
			await exportPage(page.id, page.title, outDir);
			await new Promise((r) => setTimeout(r, 2000)); // gentle on the API
		} catch (e) {
			console.error(`❌ Failed to export ${page.title}:`, e.message);
		}
	}

	const wantsHtml = await promptConfirm({
		message: `Also generate an HTML viewer from "${outDir}"?`,
		allowBack: false,
	});
	if (wantsHtml) {
		await runGenerateHtml(outDir);
	}
}

// Spawn `node generate-html.js --folder <outDir>` so the picker is skipped.
// stdio is inherited so its output streams straight to the user's terminal.
function runGenerateHtml(folder) {
	return new Promise((resolve, reject) => {
		const here = path.dirname(fileURLToPath(import.meta.url));
		const script = path.join(here, 'generate-html.js');
		const child = spawn(process.execPath, [script, '--folder', folder], {
			stdio: 'inherit',
		});
		child.on('error', reject);
		child.on('exit', (code) => {
			if (code === 0) resolve();
			else reject(new Error(`generate-html.js exited with code ${code}`));
		});
	});
}

// Handle Ctrl+C cleanly outside raw-mode (e.g. before the first prompt).
process.on('SIGINT', () => {
	if (process.stdout.isTTY) process.stdout.write('\n');
	console.log('Aborted.');
	process.exit(130);
});

main().catch((e) => {
	console.error('❌ Exporter failed:', e?.body || e);
	process.exit(1);
});
