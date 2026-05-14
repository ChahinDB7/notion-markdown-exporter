// Temporary debugging tool. Pick a Notion page, walk its block tree, and
// dump each block as compact JSON so we can see exactly how Notion represents
// things like subpage links (`child_page` / `link_to_page` / mentions).
//
// Usage:
//   node notion-inspecter.js                          -> interactive page pick
//   node notion-inspecter.js <pageNumber|id|title>    -> skip picker
//   node notion-inspecter.js ... --depth 2            -> recurse into children (default 1 = page only)
//   node notion-inspecter.js ... --full               -> print full block JSON (default: trimmed)
//   node notion-inspecter.js ... --out dump.json      -> also write JSON to file

import { Client } from '@notionhq/client';
import * as fs from 'fs/promises';
import dotenv from 'dotenv';
import { singleSelect } from './lib/tui-picker.js';

dotenv.config({ quiet: true });

const notion = new Client({ auth: process.env.NOTION_API_KEY });

function parseArgs(argv) {
	const out = { positional: [], flags: {} };
	const VALUE_FLAGS = new Set(['depth', 'out']);
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
				out.flags[name] = next;
				i++;
			} else {
				out.flags[name] = true;
			}
		} else {
			out.positional.push(a);
		}
	}
	return out;
}

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

function renderPage(p) {
	const icon = p.icon ? `${p.icon} ` : '';
	return `${icon}${p.title}   (${p.id})`;
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

// Strip the verbose audit fields that Notion adds to every block. The shape
// we care about (type, id, has_children, and the per-type payload) stays.
function trimBlock(b) {
	const { created_time, last_edited_time, created_by, last_edited_by, parent, archived, in_trash, ...rest } = b;
	return rest;
}

async function dumpTree(blockId, depth, maxDepth, full, out) {
	const children = await fetchChildren(blockId);
	for (const b of children) {
		const view = full ? b : trimBlock(b);
		const header = `${'  '.repeat(depth)}[${b.type}]  id=${b.id}  has_children=${b.has_children}`;
		console.log(header);
		const json = JSON.stringify(view, null, 2)
			.split('\n')
			.map((l) => '  '.repeat(depth + 1) + l)
			.join('\n');
		console.log(json);
		out.push({ depth, block: view });
		if (b.has_children && depth + 1 < maxDepth) {
			await dumpTree(b.id, depth + 1, maxDepth, full, out);
		}
	}
}

async function main() {
	if (!process.env.NOTION_API_KEY) {
		console.error('❌ NOTION_API_KEY is not set.');
		process.exit(1);
	}

	const args = parseArgs(process.argv);
	const maxDepth = args.flags.depth ? parseInt(args.flags.depth, 10) : 1;
	const full = !!args.flags.full;
	const outPath = args.flags.out || null;

	const pages = await listPages();
	if (pages.length === 0) {
		console.error('⚠️  No pages found. Make sure your integration is connected to at least one page.');
		process.exit(1);
	}

	let page = null;
	if (args.positional[0]) {
		page = resolvePageArg(args.positional[0], pages);
		if (!page) {
			console.error(`Couldn't resolve page "${args.positional[0]}".`);
			process.exit(1);
		}
	} else {
		page = await singleSelect({
			header: 'Pick a page to inspect:',
			items: pages,
			renderItem: renderPage,
			prefix: pageTreePrefix,
			allowBack: false,
		});
	}

	console.log(`\n🔍 Inspecting "${page.title}"  (${page.id})`);
	console.log(`   depth=${maxDepth}, full=${full}\n`);

	const dump = [];
	await dumpTree(page.id, 0, maxDepth, full, dump);

	if (outPath) {
		await fs.writeFile(outPath, JSON.stringify({ page, blocks: dump }, null, 2));
		console.log(`\n💾 Wrote ${dump.length} blocks to ${outPath}`);
	}

	const types = new Map();
	for (const { block } of dump) {
		types.set(block.type, (types.get(block.type) || 0) + 1);
	}
	console.log('\n📊 Block type counts:');
	for (const [t, n] of [...types.entries()].sort((a, b) => b[1] - a[1])) {
		console.log(`   ${n.toString().padStart(4)}  ${t}`);
	}
}

main().catch((e) => {
	console.error('❌ Inspecter failed:', e?.body || e);
	process.exit(1);
});
