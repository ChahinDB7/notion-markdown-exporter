import { Client } from '@notionhq/client';
import { NotionToMarkdown } from 'notion-to-md';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as readline from 'readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

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

// ---------- multi-select picker (raw-mode keyboard) ----------

// Toggling a page propagates the new state down to every descendant. Individual
// children can still be toggled afterwards without touching their parent — the
// parent's checkbox is just a "set all under me" shortcut.
async function multiSelectPages(pages, childrenOf) {
	if (!process.stdin.isTTY) {
		throw new Error(
			'Interactive page selection requires a TTY. Run `pnpm start` from a terminal.'
		);
	}

	// Recursive descendants: id -> [descendant ids]
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

	let cursor = 0;
	const checked = new Set();
	let message = '';
	let lastLines = 0;

	const CONTINUE_IDX = pages.length;
	const totalRows = pages.length + 1;

	const renderFrame = () => {
		let out = '';
		out += '\nWhich pages should I export?\n';
		out += '  ↑/↓ move · Space toggle · A toggle all · Enter confirm · Esc/Ctrl-C cancel\n';
		out += `  Selected: ${checked.size}/${pages.length}\n\n`;
		for (let i = 0; i < pages.length; i++) {
			const p = pages[i];
			const isCursor = i === cursor;
			const isChecked = checked.has(p.id);
			const cursorMark = isCursor ? '› ' : '  ';
			const checkbox = isChecked ? '[x]' : '[ ]';
			const prefix = pageTreePrefix(p);
			const icon = p.icon ? `${p.icon} ` : '';
			const line = `${cursorMark}${checkbox} ${prefix}${icon}${p.title}`;
			out += isCursor ? `\x1b[7m${line}\x1b[0m\n` : `${line}\n`;
		}
		const onContinue = cursor === CONTINUE_IDX;
		const continueMark = onContinue ? '› ' : '  ';
		const continueLine = `${continueMark}▶ Continue`;
		out += '\n';
		out += onContinue ? `\x1b[7m${continueLine}\x1b[0m\n` : `${continueLine}\n`;
		if (message) out += `\n${message}\n`;
		return out;
	};

	const draw = () => {
		if (lastLines > 0) process.stdout.write(`\x1b[${lastLines}A\x1b[J`);
		const frame = renderFrame();
		process.stdout.write(frame);
		lastLines = frame.split('\n').length - 1;
	};

	const toggle = (page) => {
		const newState = !checked.has(page.id);
		const apply = (id) => {
			if (newState) checked.add(id);
			else checked.delete(id);
		};
		apply(page.id);
		for (const did of descendantsOf.get(page.id) || []) apply(did);
	};

	const toggleAll = () => {
		if (checked.size === pages.length) checked.clear();
		else for (const p of pages) checked.add(p.id);
	};

	return new Promise((resolve) => {
		process.stdin.setRawMode(true);
		process.stdin.resume();
		process.stdin.setEncoding('utf8');

		const cleanup = () => {
			process.stdin.setRawMode(false);
			process.stdin.removeListener('data', onData);
			process.stdin.pause();
		};

		const onData = (key) => {
			if (key === '') {
				// Ctrl+C — raw mode swallows the signal, so handle exit ourselves.
				cleanup();
				process.stdout.write('\nAborted.\n');
				process.exit(130);
			}
			if (key === '') {
				// bare Esc
				cleanup();
				process.stdout.write('\nAborted.\n');
				process.exit(130);
			}
			const tryConfirm = () => {
				if (checked.size === 0) {
					message = '⚠️  Select at least one page (Space toggles the highlighted row).';
					draw();
					return true;
				}
				cleanup();
				process.stdout.write(`\n✅ ${checked.size} page(s) selected.\n`);
				resolve(new Set(checked));
				return true;
			};

			if (key === '[A' || key === 'k') {
				cursor = (cursor - 1 + totalRows) % totalRows;
				message = '';
			} else if (key === '[B' || key === 'j') {
				cursor = (cursor + 1) % totalRows;
				message = '';
			} else if (key === '[5~') {
				cursor = Math.max(0, cursor - 10);
				message = '';
			} else if (key === '[6~') {
				cursor = Math.min(totalRows - 1, cursor + 10);
				message = '';
			} else if (key === '[H') {
				cursor = 0;
				message = '';
			} else if (key === '[F') {
				cursor = totalRows - 1;
				message = '';
			} else if (key === ' ') {
				if (cursor === CONTINUE_IDX) {
					if (tryConfirm()) return;
				} else {
					toggle(pages[cursor]);
					message = '';
				}
			} else if (key === 'a' || key === 'A') {
				toggleAll();
				message = '';
			} else if (key === '\r' || key === '\n') {
				if (tryConfirm()) return;
			}
			draw();
		};

		process.stdin.on('data', onData);
		draw();
	});
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

async function promptOutputFolder(rl) {
	while (true) {
		const ans = (
			await rl.question(
				'\nWhich folder should the .md files go to? (press Enter for "output"): '
			)
		).trim();
		if (ans.length === 0) return 'output';
		const err = validateFolderName(ans);
		if (!err) return ans;
		console.log(`❌ ${err}`);
	}
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

	const selected = await multiSelectPages(pages, childrenOf);

	const rl = readline.createInterface({ input, output });
	const outDir = await promptOutputFolder(rl);

	console.log(`\n📁 Output folder: ${outDir}`);
	console.log(`📤 Exporting ${selected.size} page(s)…\n`);

	// Walk in tree order so output console messages match the picker order.
	for (const page of pages) {
		if (!selected.has(page.id)) continue;
		try {
			await exportPage(page.id, page.title, outDir);
			await new Promise((r) => setTimeout(r, 2000)); // gentle on the API
		} catch (e) {
			console.error(`❌ Failed to export ${page.title}:`, e.message);
		}
	}

	const ans = (await rl.question(
		`\nAlso generate an HTML viewer from "${outDir}"? (y/yes to continue, anything else to skip): `
	)).trim().toLowerCase();
	rl.close();
	if (ans === 'y' || ans === 'yes') {
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

// Handle Ctrl+C cleanly outside raw-mode (e.g. during the readline prompt).
process.on('SIGINT', () => {
	if (process.stdout.isTTY) process.stdout.write('\n');
	console.log('Aborted.');
	process.exit(130);
});

main().catch((e) => {
	console.error('❌ Exporter failed:', e?.body || e);
	process.exit(1);
});
