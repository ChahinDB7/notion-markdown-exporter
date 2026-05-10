// Push a local Markdown file into a Notion page.
//
// Usage:
//   node notion-patcher.js                              -> interactive (asks page + .md + mode)
//   node notion-patcher.js <pageNumber|pageId|title>    -> page picked, asks for .md + mode
//   node notion-patcher.js <page> <mdFileOrPath>        -> asks mode (still asks confirm)
//   node notion-patcher.js ... --smart                  -> diff-based: only write differences
//   node notion-patcher.js ... --fresh                  -> clear all + rebuild (the original behaviour)
//   node notion-patcher.js ... --dry-run                -> parse + preview, no Notion writes
//   node notion-patcher.js ... --yes                    -> skip the destructive-confirm prompt
//
// Mode summary:
//   smart : compares the page's current block tree with the markdown-derived
//           tree. Matching blocks are kept (and updated in place if their text
//           changed), missing ones are inserted, extras are deleted. Faster
//           when only a few sections changed. Falls back to clearing a single
//           parent's children when an insertion lands at position 0 (a Notion
//           API limitation), so the rest of the page is still untouched.
//   fresh : archives every block on the page and rebuilds it from scratch.
//           Use when the markdown changed substantially or you want a clean
//           slate.
//
// Create a new sub-page (instead of patching an existing one):
//   node notion-patcher.js --new "My Title" --parent <pageRef> <mdFileOrPath>
//   --new without a value     -> prompt for the title interactively
//   --parent                  -> page number / id / title that already grants the
//                                integration access; the new page is created under
//                                it. If omitted, you'll be prompted to pick one.
//   Interactive picker also offers "Create a new sub-page…" as the last choice.
//   Interactive ordering is: page (or create) -> [parent + title] -> markdown file.
//
// Behaviour for an existing page:
//   1. Reads the chosen .md, parses it with `marked`, and converts to Notion blocks.
//   2. Wraps every h1/h2/h3 as a TOGGLEABLE heading and structurally nests
//      h2 inside its h1, h3 inside its h2 (and content blocks inside the
//      deepest active heading) — matching how Notion stores toggle pages.
//   3. Deletes (archives) all current top-level children of the page.
//   4. Appends the new tree.
// For a new sub-page, step 3 is skipped (page starts empty).
//
// Requires the integration to have Read + Update + Insert content permissions.
// New top-level workspace pages cannot be created from an internal integration —
// only sub-pages of an already-accessible parent page.

import { Client } from '@notionhq/client';
import { marked } from 'marked';
import * as fs from 'fs/promises';
import * as path from 'path';
import dotenv from 'dotenv';
import { singleSelect, promptText, promptConfirm, BACK } from './lib/tui-picker.js';

dotenv.config({ quiet: true });

const notion = new Client({ auth: process.env.NOTION_API_KEY });

// ---------- arg parsing ----------

// flags that consume the next argv as their value (when used without `=`).
// `--new` is special: it can be bare (auto-derive title) or take the next arg
// only when that next arg doesn't look like another flag.
const VALUE_FLAGS = new Set(['parent', 'file']);

function parseArgs(argv) {
	const out = { positional: [], flags: {} };
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith('--')) {
			const eq = a.indexOf('=');
			if (eq >= 0) {
				out.flags[a.slice(2, eq)] = a.slice(eq + 1);
				continue;
			}
			const name = a.slice(2);
			const next = argv[i + 1];
			if (VALUE_FLAGS.has(name)) {
				out.flags[name] = next ?? true;
				i++;
			} else if (name === 'new') {
				if (next !== undefined && !next.startsWith('--')) {
					out.flags['new'] = next;
					i++;
				} else {
					out.flags['new'] = true;
				}
			} else {
				out.flags[name] = true;
			}
		} else {
			out.positional.push(a);
		}
	}
	return out;
}

// ---------- retry ----------

async function withRetry(fn, retries = 3, waitMs = 1500) {
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

// ---------- discovery ----------

// Notion page icons can be: emoji (printable in terminals), external/file
// images (we can't render in a TUI), or null. Emoji renders fine in any
// UTF-8 terminal; image icons fall back to a small placeholder so the
// indentation stays consistent.
function iconToText(icon) {
	if (!icon) return '';
	if (icon.type === 'emoji' && icon.emoji) return icon.emoji;
	if (icon.type === 'external' || icon.type === 'file') return '🖼️';
	return '';
}

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

async function listPages() {
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

// Build a parent->children map from the accessible pages, sort each level
// alphabetically by title, then walk depth-first to produce a flat array in
// display order. Each page is annotated with `_tree` metadata used to draw
// the box-drawing connectors in the picker.
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
	const cmp = (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' });
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
	return out;
}

function pageTreePrefix(page) {
	const t = page._tree;
	if (!t || t.depth === 0) return '';
	let s = '';
	for (const wasLast of t.parentLasts) s += wasLast ? '    ' : '│   ';
	s += t.isLast ? '└── ' : '├── ';
	return s;
}

// Recursively scan the project for .md files. Returns a Map keyed by folder
// path (relative to rootDir, "." for the root) -> sorted array of .md
// filenames in that folder. Folders that contain no .md files are omitted.
const MD_IGNORE_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'out']);
const MD_IGNORE_FILES = new Set(['README.md']);
async function findMarkdownFiles(rootDir = '.') {
	const byFolder = new Map();
	async function walk(dir) {
		let entries;
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		const mdHere = [];
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (entry.name.startsWith('.')) continue;
				if (MD_IGNORE_DIRS.has(entry.name)) continue;
				await walk(path.join(dir, entry.name));
			} else if (entry.isFile() && entry.name.endsWith('.md')) {
				if (MD_IGNORE_FILES.has(entry.name)) continue;
				mdHere.push(entry.name);
			}
		}
		if (mdHere.length > 0) {
			const rel = path.relative(rootDir, dir) || '.';
			byFolder.set(rel, mdHere.sort());
		}
	}
	await walk(rootDir);
	return byFolder;
}

function flattenMdMap(byFolder) {
	const out = [];
	for (const [folder, files] of byFolder) {
		for (const name of files) {
			out.push({ folder, name, path: folder === '.' ? name : path.join(folder, name) });
		}
	}
	return out;
}

// ---------- inline (rich_text) conversion ----------

const MAX_RT_CHUNK = 1900; // Notion limit is 2000 chars per rich_text item

function chunk(s, n = MAX_RT_CHUNK) {
	if (s.length <= n) return [s];
	const out = [];
	for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
	return out;
}

function decodeEntities(s) {
	if (typeof s !== 'string') return s;
	return s
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, ' ');
}

function stripHtmlTags(s) {
	return s.replace(/<[^>]*>/g, '');
}

function rt(content, ann = {}, link = null) {
	if (!content) return [];
	return chunk(content).map((c) => ({
		type: 'text',
		text: { content: c, link: link ? { url: link } : null },
		annotations: {
			bold: !!ann.bold,
			italic: !!ann.italic,
			strikethrough: !!ann.strikethrough,
			underline: !!ann.underline,
			code: !!ann.code,
			color: ann.color || 'default',
		},
	}));
}

function tokensToRichText(tokens, base = {}, link = null) {
	if (!tokens) return [];
	const out = [];
	for (const t of tokens) {
		switch (t.type) {
			case 'text':
				if (t.tokens) out.push(...tokensToRichText(t.tokens, base, link));
				else out.push(...rt(decodeEntities(t.text), base, link));
				break;
			case 'strong':
				out.push(...tokensToRichText(t.tokens, { ...base, bold: true }, link));
				break;
			case 'em':
				out.push(...tokensToRichText(t.tokens, { ...base, italic: true }, link));
				break;
			case 'codespan':
				out.push(...rt(decodeEntities(t.text), { ...base, code: true }, link));
				break;
			case 'del':
				out.push(...tokensToRichText(t.tokens, { ...base, strikethrough: true }, link));
				break;
			case 'link':
				out.push(...tokensToRichText(t.tokens, base, t.href));
				break;
			case 'br':
				out.push(...rt('\n', base, link));
				break;
			case 'image':
				// inline image -> render as a link (block-level images are detected separately)
				out.push(...rt(t.text || t.title || t.href || '', base, t.href));
				break;
			case 'html':
				out.push(...rt(decodeEntities(stripHtmlTags(t.text || '')), base, link));
				break;
			case 'escape':
				out.push(...rt(t.text || '', base, link));
				break;
			default:
				if (t.tokens) out.push(...tokensToRichText(t.tokens, base, link));
				else if (t.text) out.push(...rt(decodeEntities(t.text), base, link));
				break;
		}
	}
	return out;
}

// ---------- block factories ----------
// Each returns a "node" = { block, children, isTable? }
//   `block`     -> the payload sent to Notion (no nested `children` for non-table blocks)
//   `children`  -> sub-nodes appended in a follow-up call after the block is created

function nodeHeading(level, richText, isToggleable) {
	const key = `heading_${Math.min(Math.max(level, 1), 3)}`;
	return {
		block: {
			object: 'block',
			type: key,
			[key]: { rich_text: richText, is_toggleable: !!isToggleable, color: 'default' },
		},
		children: [],
	};
}

function nodeParagraph(richText) {
	return {
		block: {
			object: 'block',
			type: 'paragraph',
			paragraph: { rich_text: richText, color: 'default' },
		},
		children: [],
	};
}

const NOTION_CODE_LANGS = new Set([
	'abap', 'arduino', 'bash', 'basic', 'c', 'clojure', 'coffeescript', 'c++', 'c#',
	'css', 'dart', 'diff', 'docker', 'elixir', 'elm', 'erlang', 'flow', 'fortran',
	'f#', 'gherkin', 'glsl', 'go', 'graphql', 'groovy', 'haskell', 'html', 'java',
	'javascript', 'json', 'julia', 'kotlin', 'latex', 'less', 'lisp', 'livescript',
	'lua', 'makefile', 'markdown', 'markup', 'matlab', 'mermaid', 'nix',
	'objective-c', 'ocaml', 'pascal', 'perl', 'php', 'plain text', 'powershell',
	'prolog', 'protobuf', 'python', 'r', 'reason', 'ruby', 'rust', 'sass', 'scala',
	'scheme', 'scss', 'shell', 'solidity', 'sql', 'swift', 'typescript', 'vb.net',
	'verilog', 'vhdl', 'visual basic', 'webassembly', 'xml', 'yaml',
]);

function nodeCode(text, lang) {
	const lc = (lang || '').toLowerCase();
	const language = NOTION_CODE_LANGS.has(lc) ? lc : (lc === 'js' ? 'javascript' : lc === 'ts' ? 'typescript' : lc === 'sh' ? 'shell' : lc === 'yml' ? 'yaml' : 'plain text');
	return {
		block: {
			object: 'block',
			type: 'code',
			code: { rich_text: rt(text || ''), language },
		},
		children: [],
	};
}

function nodeQuote(richText, children = []) {
	return {
		block: {
			object: 'block',
			type: 'quote',
			quote: { rich_text: richText, color: 'default' },
		},
		children,
	};
}

function nodeDivider() {
	return { block: { object: 'block', type: 'divider', divider: {} }, children: [] };
}

function nodeListItem(type, richText, children = []) {
	return {
		block: {
			object: 'block',
			type,
			[type]: { rich_text: richText, color: 'default' },
		},
		children,
	};
}

function nodeTodo(richText, checked, children = []) {
	return {
		block: {
			object: 'block',
			type: 'to_do',
			to_do: { rich_text: richText, checked: !!checked, color: 'default' },
		},
		children,
	};
}

function nodeImage(url, captionRT = []) {
	return {
		block: {
			object: 'block',
			type: 'image',
			image: { type: 'external', external: { url }, caption: captionRT },
		},
		children: [],
	};
}

function nodeTable(rowsOfRichText, hasHeader) {
	const tableWidth = rowsOfRichText[0]?.length || 1;
	const tableRows = rowsOfRichText.map((cells) => ({
		object: 'block',
		type: 'table_row',
		table_row: {
			cells: cells.map((c) => (Array.isArray(c) && c.length ? c : rt(''))),
		},
	}));
	return {
		block: {
			object: 'block',
			type: 'table',
			table: {
				table_width: tableWidth,
				has_column_header: !!hasHeader,
				has_row_header: false,
				children: tableRows,
			},
		},
		children: [], // table rows are sent inline with the table block
		isTable: true,
	};
}

// ---------- token -> node(s) ----------

function tokensToNodes(tokens) {
	const out = [];
	for (const t of tokens || []) {
		const r = tokenToNode(t);
		if (!r) continue;
		if (Array.isArray(r)) out.push(...r);
		else out.push(r);
	}
	return out;
}

function isHttpUrl(u) {
	return typeof u === 'string' && /^https?:\/\//i.test(u);
}

function tokenToNode(t) {
	switch (t.type) {
		case 'space':
			return null;

		case 'heading': {
			const richText = tokensToRichText(t.tokens || []);
			return nodeHeading(t.depth, richText, t.depth <= 3);
		}

		case 'paragraph': {
			const ptokens = t.tokens || [];
			// Block-image detection: paragraph that contains exactly one image
			// (ignoring whitespace-only text fragments) becomes an image block.
			const meaningful = ptokens.filter(
				(x) => !(x.type === 'text' && /^\s*$/.test(x.text || ''))
			);
			if (meaningful.length === 1 && meaningful[0].type === 'image' && isHttpUrl(meaningful[0].href)) {
				const im = meaningful[0];
				return nodeImage(im.href, im.text ? rt(im.text) : []);
			}
			const richText = tokensToRichText(ptokens);
			if (richText.length === 0) return null;
			return nodeParagraph(richText);
		}

		case 'blockquote': {
			const inner = tokensToNodes(t.tokens || []);
			let firstRT = [];
			let rest = inner;
			if (inner.length && inner[0].block.type === 'paragraph') {
				firstRT = inner[0].block.paragraph.rich_text;
				rest = inner.slice(1);
			}
			return nodeQuote(firstRT, rest);
		}

		case 'hr':
			return nodeDivider();

		case 'code':
			return nodeCode(t.text || '', t.lang || '');

		case 'list': {
			const ordered = t.ordered;
			const items = [];
			for (const item of t.items) {
				const itemTokens = item.tokens || [];
				let itemRT = [];
				const itemChildren = [];
				let usedFirstParagraph = false;
				for (const it of itemTokens) {
					if (it.type === 'text' && itemRT.length === 0) {
						// "tight" list item — its text token holds the inline content
						itemRT = it.tokens ? tokensToRichText(it.tokens) : rt(decodeEntities(it.text || ''));
					} else if (it.type === 'paragraph' && !usedFirstParagraph && itemRT.length === 0) {
						itemRT = tokensToRichText(it.tokens || []);
						usedFirstParagraph = true;
					} else {
						const c = tokenToNode(it);
						if (!c) continue;
						if (Array.isArray(c)) itemChildren.push(...c);
						else itemChildren.push(c);
					}
				}
				if (item.task) {
					items.push(nodeTodo(itemRT, item.checked, itemChildren));
				} else if (ordered) {
					items.push(nodeListItem('numbered_list_item', itemRT, itemChildren));
				} else {
					items.push(nodeListItem('bulleted_list_item', itemRT, itemChildren));
				}
			}
			return items;
		}

		case 'table': {
			const header = (t.header || []).map((h) => tokensToRichText(h.tokens || []));
			const body = (t.rows || []).map((row) => row.map((c) => tokensToRichText(c.tokens || [])));
			const all = header.length ? [header, ...body] : body;
			if (all.length === 0) return null;
			return nodeTable(all, header.length > 0);
		}

		case 'html': {
			const text = stripHtmlTags(t.text || '').trim();
			if (!text) return null;
			return nodeParagraph(rt(decodeEntities(text)));
		}

		case 'text': {
			const richText = t.tokens ? tokensToRichText(t.tokens) : rt(decodeEntities(t.text || ''));
			if (richText.length === 0) return null;
			return nodeParagraph(richText);
		}

		case 'def':
			return null; // link reference definitions

		default:
			if (t.tokens) {
				const r = tokensToRichText(t.tokens);
				if (r.length) return nodeParagraph(r);
			} else if (t.text) {
				return nodeParagraph(rt(decodeEntities(t.text)));
			}
			return null;
	}
}

// ---------- nest by headings (the core toggle-nesting rule) ----------

function nestByHeadings(flat) {
	const root = [];
	let h1 = null;
	let h2 = null;
	let h3 = null;
	for (const n of flat) {
		const t = n.block.type;
		if (t === 'heading_1') {
			root.push(n);
			h1 = n;
			h2 = null;
			h3 = null;
		} else if (t === 'heading_2') {
			(h1 ? h1.children : root).push(n);
			h2 = n;
			h3 = null;
		} else if (t === 'heading_3') {
			(h2 ? h2.children : h1 ? h1.children : root).push(n);
			h3 = n;
		} else {
			(h3 ? h3.children : h2 ? h2.children : h1 ? h1.children : root).push(n);
		}
	}
	return root;
}

// ---------- smart patch (LCS-based diff) ----------

async function fetchChildren(blockId) {
	const all = [];
	let cursor;
	let hasMore = true;
	while (hasMore) {
		const res = await withRetry(() =>
			notion.blocks.children.list({ block_id: blockId, page_size: 100, start_cursor: cursor })
		);
		all.push(...res.results);
		hasMore = res.has_more;
		cursor = res.next_cursor;
	}
	return all;
}

function plainTextFrom(richArr) {
	if (!Array.isArray(richArr)) return '';
	return richArr
		.map((r) => r.plain_text ?? r.text?.content ?? '')
		.join('')
		.replace(/\s+/g, ' ')
		.trim();
}

// Fingerprint: a stable, content-derived key used by LCS to find matching
// blocks across the existing page and the new tree. Annotations/colors are
// intentionally ignored — only the *kind of block* and its plain text matter
// for matching. Differences in formatting trigger an in-place update later.
function fingerprintExisting(block) {
	const t = block.type;
	const data = block[t] || {};
	switch (t) {
		case 'heading_1':
		case 'heading_2':
		case 'heading_3':
		case 'paragraph':
		case 'quote':
		case 'bulleted_list_item':
		case 'numbered_list_item':
		case 'to_do':
			return `${t}|${plainTextFrom(data.rich_text)}`;
		case 'code':
			return `code|${data.language || ''}|${plainTextFrom(data.rich_text)}`;
		case 'divider':
			return 'divider';
		case 'image':
			return `image|${data.external?.url || data.file?.url || ''}`;
		case 'table':
			// rows aren't queryable here; treat tables as opaque per (width).
			// Any change to a row triggers a full table replace via blockContentDiffers.
			return `table|${data.table_width || 0}`;
		default:
			return `${t}|${plainTextFrom(data.rich_text || [])}`;
	}
}

function fingerprintNew(node) {
	const block = node.block;
	const t = block.type;
	const data = block[t] || {};
	switch (t) {
		case 'heading_1':
		case 'heading_2':
		case 'heading_3':
		case 'paragraph':
		case 'quote':
		case 'bulleted_list_item':
		case 'numbered_list_item':
		case 'to_do':
			return `${t}|${plainTextFrom(data.rich_text)}`;
		case 'code':
			return `code|${data.language || ''}|${plainTextFrom(data.rich_text)}`;
		case 'divider':
			return 'divider';
		case 'image':
			return `image|${data.external?.url || ''}`;
		case 'table':
			return `table|${data.table_width || 0}`;
		default:
			return `${t}|${plainTextFrom(data.rich_text || [])}`;
	}
}

function lcs(a, b) {
	const n = a.length;
	const m = b.length;
	if (n === 0 || m === 0) return [];
	const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
	for (let i = 1; i <= n; i++) {
		for (let j = 1; j <= m; j++) {
			dp[i][j] =
				a[i - 1] === b[j - 1]
					? dp[i - 1][j - 1] + 1
					: Math.max(dp[i - 1][j], dp[i][j - 1]);
		}
	}
	const out = [];
	let i = n;
	let j = m;
	while (i > 0 && j > 0) {
		if (a[i - 1] === b[j - 1]) {
			out.push({ eIdx: i - 1, nIdx: j - 1 });
			i--;
			j--;
		} else if (dp[i - 1][j] >= dp[i][j - 1]) {
			i--;
		} else {
			j--;
		}
	}
	return out.reverse();
}

function richTextEquals(a, b) {
	if (!Array.isArray(a) || !Array.isArray(b)) return false;
	const norm = (rts) =>
		rts.map((r) => ({
			text: r.plain_text ?? r.text?.content ?? '',
			bold: !!r.annotations?.bold,
			italic: !!r.annotations?.italic,
			code: !!r.annotations?.code,
			strikethrough: !!r.annotations?.strikethrough,
			underline: !!r.annotations?.underline,
			color: r.annotations?.color || 'default',
			href: r.href || r.text?.link?.url || null,
		}));
	return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

function blockContentDiffers(existing, newNode) {
	const t = existing.type;
	if (newNode.block.type !== t) return true;
	const e = existing[t] || {};
	const n = newNode.block[t] || {};
	switch (t) {
		case 'heading_1':
		case 'heading_2':
		case 'heading_3':
			if (!!e.is_toggleable !== !!n.is_toggleable) return true;
			return !richTextEquals(e.rich_text, n.rich_text);
		case 'paragraph':
		case 'quote':
		case 'bulleted_list_item':
		case 'numbered_list_item':
		case 'to_do':
			return !richTextEquals(e.rich_text, n.rich_text);
		case 'code':
			return e.language !== n.language || !richTextEquals(e.rich_text, n.rich_text);
		case 'divider':
			return false;
		case 'image':
			return (e.external?.url || e.file?.url || '') !== (n.external?.url || '');
		default:
			return false;
	}
}

// Block types whose "children" on the page side aren't real, recursable
// children — they're managed inline as part of the parent block payload.
// Skip child recursion for these in smart mode.
function isOpaqueChildContainer(type) {
	return type === 'table' || type === 'column_list' || type === 'column';
}

function buildUpdatePayload(existing, newNode) {
	const t = existing.type;
	const nData = newNode.block[t] || {};
	return { block_id: existing.id, [t]: { ...nData } };
}

// Recursively reconcile parentId's children with newNodes. Mutates `tally` in place.
async function smartPatchChildren(parentId, newNodes, tracker, tally) {
	const existingBlocks = await fetchChildren(parentId);

	if (existingBlocks.length === 0) {
		if (newNodes.length > 0) {
			await appendChildrenRecursive(parentId, newNodes, tracker);
			tally.inserted += countNodes(newNodes);
		}
		return;
	}
	if (newNodes.length === 0) {
		for (const e of existingBlocks) {
			await withRetry(() => notion.blocks.delete({ block_id: e.id }));
			tally.deleted++;
		}
		return;
	}

	const eKeys = existingBlocks.map(fingerprintExisting);
	const nKeys = newNodes.map(fingerprintNew);
	const matched = lcs(eKeys, nKeys);

	// Notion API can't insert at position 0 of a non-empty parent. If the first
	// new block is unmatched, clear this parent and rebuild it. This is a local
	// rebuild — the rest of the page is untouched.
	const firstNewMatched = matched.length > 0 && matched[0].nIdx === 0;
	if (!firstNewMatched) {
		for (const e of existingBlocks) {
			await withRetry(() => notion.blocks.delete({ block_id: e.id }));
			tally.deleted++;
		}
		await appendChildrenRecursive(parentId, newNodes, tracker);
		tally.inserted += countNodes(newNodes);
		return;
	}

	// Walk both arrays in lock-step against the matched pairs to produce an action list.
	const actions = [];
	let mi = 0;
	let i = 0;
	let j = 0;
	while (i < existingBlocks.length || j < newNodes.length) {
		const m = matched[mi];
		if (m && i === m.eIdx && j === m.nIdx) {
			actions.push({ type: 'keep', eIdx: i, nIdx: j });
			i++;
			j++;
			mi++;
		} else if (m && i < m.eIdx) {
			actions.push({ type: 'delete', eIdx: i++ });
		} else if (m && j < m.nIdx) {
			actions.push({ type: 'insert', nIdx: j++ });
		} else {
			while (i < existingBlocks.length) actions.push({ type: 'delete', eIdx: i++ });
			while (j < newNodes.length) actions.push({ type: 'insert', nIdx: j++ });
		}
	}

	let cursorAfterId = null;
	for (const a of actions) {
		if (a.type === 'keep') {
			const e = existingBlocks[a.eIdx];
			const n = newNodes[a.nIdx];
			if (blockContentDiffers(e, n)) {
				await withRetry(() => notion.blocks.update(buildUpdatePayload(e, n)));
				tally.updated++;
			} else {
				tally.kept++;
			}
			tracker.inc(1);
			// Tables (and column layouts) carry their children inline in the block
			// payload, so the new-tree node has `children: []` even though the
			// page-side block reports `has_children: true`. Recursing here would
			// see the page's rows/columns as "extras" with no match and wipe them.
			// Treat these as opaque in smart mode.
			if (!isOpaqueChildContainer(e.type)) {
				const newKids = n.children || [];
				if (e.has_children || newKids.length > 0) {
					await smartPatchChildren(e.id, newKids, tracker, tally);
				}
			}
			cursorAfterId = e.id;
		} else if (a.type === 'delete') {
			const e = existingBlocks[a.eIdx];
			await withRetry(() => notion.blocks.delete({ block_id: e.id }));
			tally.deleted++;
		} else if (a.type === 'insert') {
			const n = newNodes[a.nIdx];
			const payload = { block_id: parentId, children: [n.block] };
			if (cursorAfterId) payload.after = cursorAfterId;
			const res = await withRetry(() => notion.blocks.children.append(payload));
			tally.inserted++;
			tracker.inc(1);
			const insertedId = res.results[0].id;
			cursorAfterId = insertedId;
			if (n.children && n.children.length) {
				await appendChildrenRecursive(insertedId, n.children, tracker);
				tally.inserted += countNodes(n.children);
			}
		}
	}
}

// ---------- delete current page contents ----------

async function clearPage(pageId) {
	let total = 0;
	while (true) {
		const res = await withRetry(() =>
			notion.blocks.children.list({ block_id: pageId, page_size: 100 })
		);
		if (res.results.length === 0) return total;
		for (const b of res.results) {
			await withRetry(() => notion.blocks.delete({ block_id: b.id }));
			total++;
		}
		// loop again — a page can have more than 100 children
	}
}

// ---------- progress tracker ----------

function formatDuration(sec) {
	if (!Number.isFinite(sec) || sec < 0) sec = 0;
	if (sec < 60) return `${sec}s`;
	const m = Math.floor(sec / 60);
	const s = sec % 60;
	if (m < 60) return `${m}m${String(s).padStart(2, '0')}s`;
	const h = Math.floor(m / 60);
	return `${h}h${String(m % 60).padStart(2, '0')}m`;
}

class ProgressTracker {
	constructor(total, label = '') {
		this.total = total;
		this.done = 0;
		this.startedAt = Date.now();
		this.lastRender = 0;
		this.tty = !!process.stdout.isTTY;
		this.label = label;
		this.barWidth = 28;
	}
	inc(n = 1) {
		this.done = Math.min(this.total, this.done + n);
		const now = Date.now();
		if (now - this.lastRender >= 100 || this.done >= this.total) {
			this.render();
			this.lastRender = now;
		}
	}
	render(force = false) {
		const total = Math.max(1, this.total);
		const pct = Math.min(100, Math.round((this.done / total) * 100));
		const elapsedSec = (Date.now() - this.startedAt) / 1000;
		const rate = elapsedSec > 0 ? this.done / elapsedSec : 0;
		const remaining = Math.max(0, this.total - this.done);
		const etaSec = rate > 0 ? Math.round(remaining / rate) : 0;
		const filled = Math.round((this.done / total) * this.barWidth);
		const bar = '█'.repeat(filled) + '░'.repeat(this.barWidth - filled);
		const line = `  ${this.label}[${bar}] ${this.done}/${this.total} (${pct}%) · ${rate.toFixed(1)} blk/s · elapsed ${formatDuration(Math.round(elapsedSec))} · ETA ${formatDuration(etaSec)}`;
		if (this.tty) {
			process.stdout.write('\r\x1b[2K' + line);
		} else if (force || this.done === this.total || this.done % Math.max(1, Math.floor(this.total / 10)) === 0) {
			console.log(line);
		}
	}
	finish() {
		this.done = this.total;
		this.render(true);
		if (this.tty) process.stdout.write('\n');
	}
}

function countNodes(nodes) {
	let n = 0;
	for (const node of nodes) {
		n += 1;
		if (node.children && node.children.length) n += countNodes(node.children);
	}
	return n;
}

// ---------- recursive append ----------

async function appendChildrenRecursive(parentId, nodes, tracker) {
	for (let i = 0; i < nodes.length; i += 100) {
		const chunkOfNodes = nodes.slice(i, i + 100);
		const payload = chunkOfNodes.map((n) => n.block);
		const res = await withRetry(() =>
			notion.blocks.children.append({ block_id: parentId, children: payload })
		);
		if (tracker) tracker.inc(chunkOfNodes.length);
		for (let j = 0; j < chunkOfNodes.length; j++) {
			const node = chunkOfNodes[j];
			if (node.isTable) continue; // rows already created inline
			if (node.children && node.children.length) {
				await appendChildrenRecursive(res.results[j].id, node.children, tracker);
			}
		}
	}
}

// ---------- preview ----------

function previewTree(nodes, depth = 0, lines = []) {
	for (const n of nodes) {
		const t = n.block.type;
		const data = n.block[t];
		let text = '';
		if (data && Array.isArray(data.rich_text)) {
			text = data.rich_text.map((r) => r.text?.content || '').join('').replace(/\s+/g, ' ').slice(0, 70);
		}
		const tog = data && data.is_toggleable ? ' [TOGGLE]' : '';
		lines.push(`${'  '.repeat(depth)}- ${t}${tog}${text ? `  "${text}${text.length === 70 ? '…' : ''}"` : ''}`);
		if (n.children && n.children.length) previewTree(n.children, depth + 1, lines);
	}
	return lines;
}

// ---------- prompts ----------

function renderPage(p) {
	const icon = p.icon ? `${p.icon} ` : '';
	return `${icon}${p.title}   (${p.id})`;
}

// Folder-scope items for the markdown folder picker. "output" first
// (if present), then every other folder alphabetically, with "Whole project"
// at the end as a catch-all.
function buildMdFolderOptions(allMd) {
	const folders = [...allMd.keys()];
	const totalFiles = folders.reduce((s, f) => s + allMd.get(f).length, 0);
	const otherFolders = folders.filter((f) => f !== 'output').sort();
	const opts = [];
	if (allMd.has('output')) {
		opts.push({ kind: 'folder', folder: 'output', count: allMd.get('output').length });
	}
	for (const folder of otherFolders) {
		opts.push({ kind: 'folder', folder, count: allMd.get(folder).length });
	}
	opts.push({ kind: 'all', count: totalFiles, folderCount: folders.length });
	return opts;
}

function renderMdFolderOption(o) {
	if (o.kind === 'all')
		return `🌐 Whole project  (${o.count} file${o.count === 1 ? '' : 's'} across ${o.folderCount} folder${o.folderCount === 1 ? '' : 's'})`;
	const label = o.folder === '.' ? './' : `${o.folder}/`;
	return `📁 ${label}  (${o.count} file${o.count === 1 ? '' : 's'})`;
}

// Flat file list for the markdown file picker. folderChoice is one of
// the items returned by buildMdFolderOptions, or null when there's only
// one folder in the project (in which case we list every file in it).
function buildMdFileItems(folderChoice, allMd) {
	let byFolder;
	if (!folderChoice || folderChoice.kind === 'all') {
		byFolder = allMd;
	} else {
		byFolder = new Map([[folderChoice.folder, allMd.get(folderChoice.folder)]]);
	}
	return flattenMdMap(byFolder);
}

// Stable identity for the folder choice; used to invalidate file
// selection when the folder changes via Esc-back.
function mdFolderKey(choice) {
	if (!choice) return null;
	return choice.kind === 'all' ? 'ALL' : choice.folder;
}

function resolvePageArg(arg, pages) {
	if (!arg) return null;
	if (/^\d+$/.test(arg)) return pages[parseInt(arg, 10) - 1] || null;
	const flat = arg.replace(/-/g, '');
	const byId = pages.find((p) => p.id === arg || p.id.replace(/-/g, '') === flat);
	if (byId) return byId;
	const lower = arg.toLowerCase();
	return pages.find((p) => p.title.toLowerCase() === lower) || null;
}

async function createSubPage(parentId, title) {
	const res = await withRetry(() =>
		notion.pages.create({
			parent: { type: 'page_id', page_id: parentId },
			properties: {
				title: { title: [{ type: 'text', text: { content: title } }] },
			},
		})
	);
	return { id: res.id, title };
}

async function resolveMdArg(arg, byFolder) {
	if (!arg) return null;
	const flat = flattenMdMap(byFolder);
	// Prefer files in output/ when there's a name collision across folders.
	flat.sort((a, b) => (a.folder === 'output' ? -1 : b.folder === 'output' ? 1 : 0));
	const direct = flat.find(
		(f) => f.name === arg || f.path === arg || f.name === `${arg}.md`
	);
	if (direct) return direct;
	if (/^\d+$/.test(arg)) return flat[parseInt(arg, 10) - 1] || null;
	try {
		await fs.access(arg);
		return { name: path.basename(arg), path: arg, folder: path.dirname(arg) || '.' };
	} catch {
		return null;
	}
}

// ---------- main ----------

async function main() {
	if (!process.env.NOTION_API_KEY) {
		console.error('❌ NOTION_API_KEY is not set. See README.md.');
		process.exit(1);
	}

	const args = parseArgs(process.argv);
	const dryRun = !!args.flags['dry-run'];
	const skipConfirm = !!args.flags['yes'] || !!args.flags['y'];
	// --new can be a string (the desired title) or a bare flag (auto-derive title)
	const newFlag = args.flags['new'];
	const wantNew = newFlag !== undefined;
	const parentRef = args.flags['parent'];
	const cliMode = args.flags.smart ? 'smart' : args.flags.fresh ? 'fresh' : null;

	// Early exit: bail before touching the Notion API if there's no markdown to push.
	const allMd = await findMarkdownFiles('.');
	if (allMd.size === 0) {
		console.error('⚠️  No .md files found anywhere in this project. Run `pnpm start` to export from Notion first.');
		process.exit(1);
	}

	const pages = await listPages();
	if (pages.length === 0) {
		console.error('⚠️  No pages found. Make sure your integration is connected to at least one page.');
		process.exit(1);
	}

	const CREATE_SENTINEL = { __create: true };
	const rootPages = pages.filter((p) => p._tree?.depth === 0);

	// ---- pre-resolve from CLI args ----
	// Each *FromCli flag tells the state machine to skip that step entirely.
	// Steps for inputs supplied via CLI never appear in the back-stack.
	let page = null;
	let createMode = wantNew;
	let parentPage = null;
	let newTitle = typeof newFlag === 'string' ? newFlag : null;
	let chosenFolder = null; // result of pick_md_folder
	let mdFile = null;
	let mode = cliMode;

	const pageFromCli = !wantNew && !!args.positional[0];
	const parentFromCli = !!parentRef;
	const titleFromCli = typeof newFlag === 'string';
	const mdArg =
		args.flags.file || (wantNew ? args.positional[0] : args.positional[1]);
	const mdFromCli = !!mdArg;
	const modeFromCli = !!cliMode;

	if (pageFromCli) {
		page = resolvePageArg(args.positional[0], pages);
		if (!page) {
			console.error(`Couldn't resolve page "${args.positional[0]}".`);
			process.exit(1);
		}
	}
	if (createMode && parentFromCli) {
		parentPage = resolvePageArg(parentRef, pages);
		if (!parentPage) {
			console.error(`Couldn't resolve --parent "${parentRef}".`);
			process.exit(1);
		}
	}
	if (mdFromCli) {
		mdFile = await resolveMdArg(mdArg, allMd);
		if (!mdFile) {
			console.error(`Couldn't resolve markdown file "${mdArg}".`);
			process.exit(1);
		}
	}

	// Cursor / draft state for re-entry after Esc-back.
	let pickPageIndex = 0;
	let pickParentIndex = 0;
	let titleDraft = newTitle || '';
	let pickMdFolderIndex = 0;
	let pickMdFileIndex = 0;
	let pickModeIndex = 0;

	// Parse cache so backing in/out of confirm doesn't re-read/parse the file.
	let parseCache = null; // { path, md, tree, flat, previewLines }
	let summaryPrinted = false;

	const ensureParse = async () => {
		if (parseCache && parseCache.path === mdFile.path) return parseCache;
		const md = await fs.readFile(mdFile.path, 'utf-8');
		const tokens = marked.lexer(md);
		const flat = tokensToNodes(tokens);
		const tree = nestByHeadings(flat);
		const previewLines = previewTree(tree);
		parseCache = { path: mdFile.path, md, tree, flat, previewLines };
		return parseCache;
	};

	const printSummary = (effectiveMode) => {
		const summaryHeader = createMode
			? `Will CREATE a new sub-page "${newTitle}" under "${parentPage.title}" and fill it.`
			: effectiveMode === 'smart'
				? `Will SMART-PATCH "${page.title}" (only differences are written).`
				: `Will REPLACE the contents of "${page.title}".`;
		console.log(`\n${summaryHeader}`);
		console.log(`Source file : ${mdFile.path}`);
		console.log(`Mode        : ${dryRun ? 'DRY RUN (no Notion writes)' : 'LIVE'}`);
		console.log(`\nParsed ${parseCache.flat.length} blocks → ${parseCache.tree.length} top-level after heading nesting.`);
		console.log('\nBlock tree preview:');
		console.log(parseCache.previewLines.slice(0, 50).join('\n'));
		if (parseCache.previewLines.length > 50) console.log(`  … (+${parseCache.previewLines.length - 50} more)`);
		summaryPrinted = true;
	};

	// ---- state machine ----
	// States: pick_page, pick_parent, enter_title, pick_md_folder,
	// pick_md_file, pick_mode, confirm. Each step is included only when its
	// data isn't pre-resolved from CLI args (and its precondition holds —
	// e.g. pick_parent only applies in create-mode). The very first step
	// of the run gets allowBack=false (Esc does nothing); every other step
	// allows Esc to pop back to the previously visited state with prior
	// inputs preserved (pickXxxIndex / titleDraft).
	const ORDER = ['pick_page', 'pick_parent', 'enter_title', 'pick_md_folder', 'pick_md_file', 'pick_mode', 'confirm'];
	const isStateActive = (s) => {
		switch (s) {
			case 'pick_page': return !pageFromCli && !createMode;
			case 'pick_parent': return createMode && !parentFromCli;
			case 'enter_title': return createMode && !titleFromCli;
			case 'pick_md_folder': return !mdFromCli && allMd.size > 1;
			case 'pick_md_file': return !mdFromCli;
			case 'pick_mode': return !createMode && !modeFromCli;
			case 'confirm': return !skipConfirm && !dryRun;
		}
		return false;
	};
	const nextStateAfter = (cur) => {
		const startIdx = cur === null ? 0 : ORDER.indexOf(cur) + 1;
		for (let i = startIdx; i < ORDER.length; i++) {
			if (isStateActive(ORDER[i])) return ORDER[i];
		}
		return 'done';
	};

	let state = nextStateAfter(null);
	const history = [];

	while (state !== 'done') {
		const allowBack = history.length > 0;

		if (state === 'pick_page') {
			const choices = [...pages, CREATE_SENTINEL];
			const result = await singleSelect({
				header: 'Which Notion page should I patch?',
				items: choices,
				renderItem: (c) => c === CREATE_SENTINEL ? '➕ Create a new sub-page…' : renderPage(c),
				prefix: (c) => c === CREATE_SENTINEL ? '' : pageTreePrefix(c),
				allowBack,
				initialIndex: pickPageIndex,
			});
			if (result === BACK) { state = history.pop(); continue; }
			pickPageIndex = choices.indexOf(result);
			if (result === CREATE_SENTINEL) {
				createMode = true;
				page = null;
			} else {
				createMode = false;
				page = result;
			}
			history.push(state);
			state = nextStateAfter(state);
			continue;
		}

		if (state === 'pick_parent') {
			const result = await singleSelect({
				header: 'Pick a parent page (the new page will be created under it):',
				items: rootPages,
				renderItem: renderPage,
				allowBack,
				initialIndex: pickParentIndex,
			});
			if (result === BACK) { state = history.pop(); continue; }
			pickParentIndex = rootPages.indexOf(result);
			parentPage = result;
			history.push(state);
			state = nextStateAfter(state);
			continue;
		}

		if (state === 'enter_title') {
			const result = await promptText({
				message: 'Enter a title for the new sub-page:',
				defaultValue: 'Untitled',
				allowBack,
				initialValue: titleDraft,
			});
			if (result === BACK) { state = history.pop(); continue; }
			newTitle = result;
			titleDraft = result;
			history.push(state);
			state = nextStateAfter(state);
			continue;
		}

		if (state === 'pick_md_folder') {
			const opts = buildMdFolderOptions(allMd);
			const result = await singleSelect({
				header: 'Where should I look for markdown files?',
				items: opts,
				renderItem: renderMdFolderOption,
				allowBack,
				initialIndex: pickMdFolderIndex,
			});
			if (result === BACK) { state = history.pop(); continue; }
			// Folder change invalidates any previously-picked file: it might
			// not exist in the new scope.
			if (mdFolderKey(chosenFolder) !== mdFolderKey(result)) {
				mdFile = null;
				pickMdFileIndex = 0;
			}
			pickMdFolderIndex = opts.indexOf(result);
			chosenFolder = result;
			history.push(state);
			state = nextStateAfter(state);
			continue;
		}

		if (state === 'pick_md_file') {
			const items = buildMdFileItems(chosenFolder, allMd);
			const result = await singleSelect({
				header: 'Which markdown file should I push to that page?',
				items,
				renderItem: (f) => f.name,
				groupHeader: (f, prev) => (!prev || prev.folder !== f.folder)
					? `📁 ${f.folder === '.' ? './' : f.folder + '/'}`
					: null,
				allowBack,
				initialIndex: pickMdFileIndex,
			});
			if (result === BACK) { state = history.pop(); continue; }
			pickMdFileIndex = items.indexOf(result);
			mdFile = result;
			history.push(state);
			state = nextStateAfter(state);
			continue;
		}

		if (state === 'pick_mode') {
			const MODES = [
				{ key: 'smart', label: '🧠 Smart — only adjust differences (recommended for small edits)' },
				{ key: 'fresh', label: '🔄 Fresh — delete everything, then add from scratch (recommended for big rewrites)' },
			];
			const result = await singleSelect({
				header: 'Which patch mode?',
				items: MODES,
				renderItem: (m) => m.label,
				allowBack,
				initialIndex: pickModeIndex,
			});
			if (result === BACK) { state = history.pop(); continue; }
			pickModeIndex = MODES.indexOf(result);
			mode = result.key;
			history.push(state);
			state = nextStateAfter(state);
			continue;
		}

		if (state === 'confirm') {
			await ensureParse();
			const effMode = createMode ? 'fresh' : mode;
			printSummary(effMode);
			const confirmMessage = createMode
				? `Create "${newTitle}" under "${parentPage.title}" and fill it from ${mdFile.path}?`
				: effMode === 'smart'
					? `Smart-patch "${page.title}" from ${mdFile.path} (only differences will be written)?`
					: `This will DELETE all current contents of "${page.title}" and replace them.`;
			const ok = await promptConfirm({
				message: confirmMessage,
				allowBack,
			});
			if (ok === BACK) { state = history.pop(); continue; }
			if (!ok) { console.log('Aborted.'); return; }
			history.push(state);
			state = nextStateAfter(state);
			continue;
		}

		throw new Error(`Unknown state: ${state}`);
	}

	// createMode never goes through pick_mode — force fresh insert.
	if (createMode) mode = 'fresh';

	// Make sure parse + summary have happened (e.g. when --yes/--dry-run skipped confirm).
	await ensureParse();
	if (!summaryPrinted) printSummary(mode);

	if (dryRun) {
		console.log('\nDRY RUN: not touching Notion. Done.');
		return;
	}

	const tree = parseCache.tree;
	const totalNew = countNodes(tree);
	const t0 = Date.now();

	if (createMode) {
		console.log(`\n🆕 Creating "${newTitle}" under "${parentPage.title}"…`);
		const created = await createSubPage(parentPage.id, newTitle);
		console.log(`   created page ${created.id}`);
		console.log(`📤 Appending ${totalNew} new block(s)…\n`);
		const tracker = new ProgressTracker(totalNew);
		await appendChildrenRecursive(created.id, tree, tracker);
		tracker.finish();
		const elapsed = Math.round((Date.now() - t0) / 1000);
		console.log(`✅ Done — ${totalNew} block(s) in ${formatDuration(elapsed)}.`);
		return;
	}

	if (mode === 'smart') {
		console.log(`\n🧠 Smart patching "${page.title}" — comparing against ${totalNew} target block(s)…\n`);
		const tracker = new ProgressTracker(totalNew);
		const tally = { kept: 0, updated: 0, inserted: 0, deleted: 0 };
		await smartPatchChildren(page.id, tree, tracker, tally);
		tracker.finish();
		const elapsed = Math.round((Date.now() - t0) / 1000);
		console.log(
			`✅ Done in ${formatDuration(elapsed)} — ${tally.kept} kept, ${tally.updated} updated, ${tally.inserted} inserted, ${tally.deleted} deleted.`
		);
		return;
	}

	// fresh mode
	console.log('\n🗑  Clearing page…');
	const removed = await clearPage(page.id);
	console.log(`   removed ${removed} top-level block(s).`);
	console.log(`📤 Appending ${totalNew} new block(s)…\n`);
	const tracker = new ProgressTracker(totalNew);
	await appendChildrenRecursive(page.id, tree, tracker);
	tracker.finish();
	const elapsed = Math.round((Date.now() - t0) / 1000);
	console.log(`✅ Done — ${totalNew} block(s) in ${formatDuration(elapsed)}.`);
}

function isAbort(e) {
	return e && (e.code === 'ABORT_ERR' || e.name === 'AbortError' || e.code === 'ERR_USE_AFTER_CLOSE');
}

// Handle Ctrl+C cleanly when it fires before any raw-mode prompt is active.
// (Inside a prompt, the runner intercepts \x03 directly.)
process.on('SIGINT', () => {
	if (process.stdout.isTTY) process.stdout.write('\n');
	console.log('Aborted.');
	process.exit(130);
});

main().catch((e) => {
	if (isAbort(e)) {
		if (process.stdout.isTTY) process.stdout.write('\n');
		console.log('Aborted.');
		process.exit(130);
	}
	console.error('❌ Patcher failed:', e?.body || e);
	process.exit(1);
});
