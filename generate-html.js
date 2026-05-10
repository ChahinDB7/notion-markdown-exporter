import fs from 'fs/promises';
import path from 'path';
import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import sanitizeHtml from 'sanitize-html';
import escapeHtml from 'escape-html';
import { marked } from 'marked';

const MD_IGNORE_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'out']);
const MD_IGNORE_FILES = new Set(['README.md']);

// Walk the project recursively and return every folder that directly contains
// at least one .md file (excluding ignored files/dirs and the project root
// itself). Each entry is { folder: relative path, count: number of .md files }.
async function findFoldersWithMarkdown(rootDir = '.') {
  const folders = [];
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
        if (MD_IGNORE_DIRS.has(entry.name)) continue;
        await walk(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        if (MD_IGNORE_FILES.has(entry.name)) continue;
        mdCount++;
      }
    }
    if (mdCount > 0) {
      const rel = path.relative(rootDir, dir) || '.';
      // Skip the project root — render-target must be an actual folder.
      if (rel !== '.') folders.push({ folder: rel, count: mdCount });
    }
  }
  await walk(rootDir);
  folders.sort((a, b) => {
    // Prefer a plain "output" folder when it exists, then alphabetical.
    if (a.folder === 'output' && b.folder !== 'output') return -1;
    if (b.folder === 'output' && a.folder !== 'output') return 1;
    return a.folder.localeCompare(b.folder, undefined, { numeric: true });
  });
  return folders;
}

function sortFilesForSidebar(files) {
  const items = files.map((f) => {
    const stem = f.replace(/\.md$/, '');
    const m = stem.match(/^(\d+)[-_\s.]+/);
    return { file: f, stem, num: m ? parseInt(m[1], 10) : null };
  });
  const numeric = items.filter((i) => i.num !== null).sort((a, b) => a.num - b.num);
  const nonNumeric = items
    .filter((i) => i.num === null)
    .sort((a, b) => a.stem.localeCompare(b.stem, undefined, { numeric: true, sensitivity: 'base' }));
  const main = nonNumeric.shift(); // first alphabetical non-numeric = main page
  return [
    ...(main ? [main] : []),
    ...numeric,
    ...nonNumeric,
  ].map((i) => i.file);
}

async function pickFolder(folders) {
  // Single folder: just use it. No prompt, no extra noise.
  if (folders.length === 1) return folders[0].folder;
  const rl = readline.createInterface({ input, output });
  console.log('\nWhich folder of markdown files should I render?');
  const indexWidth = String(folders.length).length;
  folders.forEach((f, i) => {
    const num = String(i + 1).padStart(indexWidth, ' ');
    console.log(`  [${num}] 📁 ${f.folder}/  (${f.count} file${f.count === 1 ? '' : 's'})`);
  });
  try {
    while (true) {
      const ans = (await rl.question(`Pick a number (1-${folders.length}): `)).trim();
      const n = parseInt(ans, 10);
      if (Number.isInteger(n) && n >= 1 && n <= folders.length) {
        return folders[n - 1].folder;
      }
      console.log('Invalid selection.');
    }
  } finally {
    rl.close();
  }
}

function escapeForJs(str) {
  // Escape backslashes, backticks, and ${ to prevent template injection
  return str
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
}

function generateHTML(pages) {
  const pageNames = Object.keys(pages);
  const hasMultiplePages = pageNames.length > 1;

  const pagesObjectString = pageNames
    .map(
      (title) => `"${escapeForJs(title)}": \`${escapeForJs(pages[title])}\``
    )
    .join(',\n');

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Markdown Viewer</title>
  <style>
    :root {
      color-scheme: dark;
    }
    body {
      margin: 0;
      font-family: sans-serif;
      display: flex;
      height: 100vh;
      background: #121212;
      color: #e4e4e4;
    }
    img {
      max-width: 40dvw;
      max-height: 40dvh;
      object-fit: contain;
    }
    .sidebar {
      width: 250px;
      background: #1b1b1b;
      border-right: 1px solid #2a2a2a;
      padding: 1em;
      overflow-y: auto;
    }
    .hamburger {
      display: none;
      position: fixed;
      top: 0.75em;
      right: 0.75em;
      z-index: 30;
      width: 40px;
      height: 40px;
      background: #1b1b1b;
      border: 1px solid #2a2a2a;
      border-radius: 6px;
      padding: 0;
      cursor: pointer;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      gap: 4px;
    }
    .hamburger span {
      display: block;
      width: 18px;
      height: 2px;
      background: #e4e4e4;
      border-radius: 1px;
      transition: transform 0.25s ease, opacity 0.18s ease;
      transform-origin: center;
    }
    .hamburger.open span:nth-child(1) {
      transform: translateY(6px) rotate(45deg);
    }
    .hamburger.open span:nth-child(2) {
      opacity: 0;
      transform: scaleX(0);
    }
    .hamburger.open span:nth-child(3) {
      transform: translateY(-6px) rotate(-45deg);
    }
    .hamburger:active {
      transform: scale(0.94);
    }
    .hamburger {
      transition: transform 0.12s ease, background 0.2s ease;
    }
    .sidebar-backdrop {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.5);
      z-index: 10;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.25s ease;
    }
    .sidebar-backdrop.open {
      opacity: 1;
      pointer-events: auto;
    }
    .nav-item {
      display: block;
      padding: 0.5em 0;
      text-decoration: none;
      color: #b8b8b8;
      cursor: pointer;
    }
    .nav-item:hover {
      color: #ffffff;
    }
    .nav-item.active {
      font-weight: bold;
      color: #ffffff;
    }
    .content {
      flex: 1;
      padding: 2em;
      overflow-y: auto;
      background: #121212;
      color: #e4e4e4;
    }
    .content a {
      color: #7ab8ff;
    }
    .content a:hover {
      color: #a5ccff;
    }
    .content {
      font-size: 14px;
      line-height: 1.55;
    }
    .content p {
      margin: 0.5em 0;
    }
    .content h1, .content h2, .content h3, .content h4, .content h5, .content h6 {
      color: #ffffff;
      line-height: 1.25;
      margin: 0.8em 0 0.3em;
    }
    .content h1 { font-size: 1.5em; }
    .content h2 { font-size: 1.25em; }
    .content h3 { font-size: 1.1em; }
    .content h4 { font-size: 1em; }
    .content h5 { font-size: 0.9em; }
    .content h6 { font-size: 0.85em; color: #b8b8b8; }
    .content code {
      background: #1f1f1f;
      color: #f0c674;
      padding: 0.15em 0.35em;
      border-radius: 4px;
      font-size: 0.95em;
    }
    .content pre {
      background: #1a1a1a;
      color: #e4e4e4;
      padding: 1em;
      border-radius: 6px;
      overflow-x: auto;
      border: 1px solid #2a2a2a;
    }
    .content pre code {
      background: transparent;
      color: inherit;
      padding: 0;
    }
    .content blockquote {
      border-left: 4px solid #3a3a3a;
      margin: 1em 0;
      padding: 0.25em 1em;
      color: #b8b8b8;
      background: #181818;
    }
    /* Responsive table styles */
    .content .table-wrap {
      overflow-x: auto;
      max-width: 100%;
      margin: 10px 0 2em;
      -webkit-overflow-scrolling: touch;
    }
    .content table {
      border-collapse: collapse;
    }
    @media (min-width: 701px) {
      .content td {
        max-width: 400px;
      }
    }
    .content th, .content td {
      border: 1px solid #2e2e2e;
      padding: 0.75em 1em;
      text-align: left;
    }
    .content th {
      background: #1e2530;
      color: #ffffff;
      font-weight: 600;
      font-size: 1.05em;
      letter-spacing: 0.03em;
      border-bottom: 2px solid #2d3d52;
    }
    .content td {
      background: #161616;
      color: #e4e4e4;
    }
    .content tr:nth-child(even) td {
      background: #1c1c1c;
    }
    /* Collapsible heading toggles (Notion-style) */
    details.toggle {
      margin: 0.4em 0;
    }
    details.toggle > summary {
      list-style: none;
      cursor: pointer;
      display: flex;
      align-items: baseline;
      gap: 0.5em;
      user-select: none;
    }
    details.toggle > summary::-webkit-details-marker {
      display: none;
    }
    details.toggle > summary::before {
      content: "";
      display: inline-block;
      width: 0;
      height: 0;
      border-left: 5px solid #888;
      border-top: 4px solid transparent;
      border-bottom: 4px solid transparent;
      transition: transform 0.15s ease;
      flex-shrink: 0;
      transform: translateY(-2px);
    }
    details.toggle[open] > summary::before {
      transform: translateY(-2px) rotate(90deg);
    }
    details.toggle > summary > h1,
    details.toggle > summary > h2,
    details.toggle > summary > h3 {
      margin: 10px 0 0;
      display: inline-block;
    }
    .toggle-content {
      margin: 0.3em 0 0.6em 0.4em;
      padding-left: 0.9em;
      border-left: 1px solid #2a2a2a;
    }
    /* Add custom hr style */
    hr.section-divider {
      border: none;
      border-top: 1.5px solid #2e2e2e;
      margin: 2.2em 0 1.2em 0;
      height: 0;
      background: none;
      opacity: 0.9;
    }
    @media (max-width: 700px) {
      .hamburger {
        display: flex;
      }
      .sidebar {
        position: fixed;
        top: 0;
        left: 0;
        height: 100vh;
        z-index: 20;
        width: 250px;
        transform: translateX(-100%);
        transition: transform 0.25s ease;
      }
      .sidebar.open {
        transform: translateX(0);
        box-shadow: 4px 0 20px rgba(0, 0, 0, 0.5);
      }
      .content {
        padding-top: 4em;
      }
      .content p {
        font-size: 13px;
      }
      .content table {
        width: 100%;
      }
    }
  </style>
</head>
<body>
  ${hasMultiplePages ? `<button class="hamburger" id="hamburger" aria-label="Toggle menu"><span></span><span></span><span></span></button>
  <div class="sidebar" id="sidebar"></div>
  <div class="sidebar-backdrop" id="sidebar-backdrop"></div>` : ''}
  <div class="content" id="content"></div>

  <script>
    const pages = {
      ${pagesObjectString}
    };

    // kebabToTitle function for use in the browser
    function kebabToTitle(str) {
      return str
        .replace(/-/g, ' ')
        .replace(/\\b\\w/g, c => c.toUpperCase());
    }

    // Build a sidebar-friendly title from a filename stem:
    //   "01-foundation"        -> "1. Foundation"
    //   "10-tooling-reference" -> "10. Tooling Reference"
    //   "tradingbot copy"      -> "Tradingbot Copy"
    function fileNameToTitle(stem) {
      const m = stem.match(/^(\\d+)[-_\\s.]+(.*)$/);
      if (m) {
        const num = parseInt(m[1], 10);
        const rest = m[2].replace(/[-_]/g, ' ').replace(/\\b\\w/g, c => c.toUpperCase());
        return num + ". " + rest;
      }
      return stem.replace(/[-_]/g, ' ').replace(/\\b\\w/g, c => c.toUpperCase());
    }

    // Extract first <h1> innerText from HTML string, or null if not found
    function extractFirstH1(html) {
      // Try to match real <h1> tags first
      let match = html.match(/<h1[^>]*>([\\s\\S]*?)<\\/h1>/i);
      if (match) {
        // Remove any HTML tags inside h1
        return match[1].replace(/<[^>]+>/g, '').trim();
      }
      // Fallback: try to match escaped <h1> (e.g. &lt;h1&gt;Title&lt;/h1&gt;)
      match = html.match(/&lt;h1[^&]*&gt;([\\s\\S]*?)&lt;\\/h1&gt;/i);
      if (match) {
        // Remove any escaped tags inside
        return match[1].replace(/&lt;[^&]+&gt;/g, '').trim();
      }
      return null;
    }

    // Group h1/h2/h3 sections into Notion-style collapsible toggles.
    // Rule: h1 only becomes a toggle when there are multiple h1s. h2 and h3
    // always become toggles when they have content. Content directly under a
    // toggle is indented; non-toggle headings stay flat.
    function makeCollapsible(container, pageKey) {
      const topChildren = Array.from(container.children);
      const h1Count = topChildren.filter(e => e.tagName === "H1").length;
      // Track sibling counters so duplicate headings at the same scope still
      // get unique storage keys.
      function process(elements, parentPath) {
        const result = [];
        const siblingCounts = {};
        let i = 0;
        while (i < elements.length) {
          const el = elements[i];
          const m = el.tagName && el.tagName.match(/^H([1-3])$/);
          if (!m) {
            result.push(el);
            i++;
            continue;
          }
          const level = parseInt(m[1]);
          const headingText = (el.textContent || "").trim();
          const sibKey = "h" + level + ":" + headingText;
          siblingCounts[sibKey] = (siblingCounts[sibKey] || 0) + 1;
          const dedupSuffix = siblingCounts[sibKey] > 1 ? "#" + siblingCounts[sibKey] : "";
          const myPath = (parentPath ? parentPath + " > " : "") + "h" + level + ":" + headingText + dedupSuffix;

          const children = [];
          let j = i + 1;
          while (j < elements.length) {
            const next = elements[j];
            const nm = next.tagName && next.tagName.match(/^H([1-6])$/);
            if (nm && parseInt(nm[1]) <= level) break;
            children.push(next);
            j++;
          }
          if (children.length && children[0].tagName === "HR" && children[0].classList.contains("section-divider")) {
            children.shift();
          }

          if (children.length === 0) {
            result.push(el);
          } else {
            const processedChildren = process(children, myPath);
            const collapsible = level === 1 ? h1Count > 1 : true;
            if (collapsible) {
              const details = document.createElement("details");
              details.className = "toggle toggle-h" + level;
              const storageKey = "notion-toggle:" + pageKey + "::" + myPath;
              let initial = true;
              try {
                const stored = localStorage.getItem(storageKey);
                if (stored === "0") initial = false;
                else if (stored === "1") initial = true;
              } catch (e) { /* localStorage unavailable */ }
              details.open = initial;
              details.addEventListener("toggle", () => {
                try {
                  localStorage.setItem(storageKey, details.open ? "1" : "0");
                } catch (e) { /* ignore */ }
              });
              const summary = document.createElement("summary");
              summary.appendChild(el);
              const content = document.createElement("div");
              content.className = "toggle-content";
              processedChildren.forEach(c => content.appendChild(c));
              details.appendChild(summary);
              details.appendChild(content);
              result.push(details);
            } else {
              result.push(el);
              processedChildren.forEach(c => result.push(c));
            }
          }
          i = j;
        }
        return result;
      }

      const processed = process(topChildren, "");
      container.innerHTML = "";
      processed.forEach(el => container.appendChild(el));
    }

    function closeMobileSidebar() {
      const sidebar = document.getElementById("sidebar");
      const backdrop = document.getElementById("sidebar-backdrop");
      const hamburger = document.getElementById("hamburger");
      if (sidebar) sidebar.classList.remove("open");
      if (backdrop) backdrop.classList.remove("open");
      if (hamburger) hamburger.classList.remove("open");
    }

    function loadPage(title) {
      const content = pages[title] || "<p>Page not found.</p>";
      const contentEl = document.getElementById("content");
      contentEl.innerHTML = content;
      makeCollapsible(contentEl, title);

      const displayTitle = extractFirstH1(content) || kebabToTitle(title);
      document.title = displayTitle + " - Markdown Viewer";

      // Highlight current
      document.querySelectorAll(".nav-item").forEach(el => el.classList.remove("active"));
      const currentNav = document.getElementById("nav-" + title);
      if (currentNav) currentNav.classList.add("active");

      closeMobileSidebar();
    }

    function renderSidebar() {
      const sidebar = document.getElementById("sidebar");
      if (!sidebar) return;
      sidebar.innerHTML = "";

      Object.keys(pages).forEach(title => {
        const link = document.createElement("a");
        link.textContent = fileNameToTitle(title);
        link.href = "#";
        link.className = "nav-item";
        link.id = "nav-" + title;
        link.onclick = () => loadPage(title);
        sidebar.appendChild(link);
      });
    }

    // On load
    window.onload = () => {
      renderSidebar();

      const hamburger = document.getElementById("hamburger");
      const sidebar = document.getElementById("sidebar");
      const backdrop = document.getElementById("sidebar-backdrop");
      if (hamburger && sidebar && backdrop) {
        hamburger.addEventListener("click", () => {
          sidebar.classList.toggle("open");
          backdrop.classList.toggle("open");
          hamburger.classList.toggle("open");
        });
        backdrop.addEventListener("click", closeMobileSidebar);
      }

      const firstPage = Object.keys(pages)[0];
      loadPage(firstPage);
    };
  </script>
</body>
</html>
`.trim();
}


// Minimal arg parsing so callers can skip the folder picker:
//   node generate-html.js --folder output
//   node generate-html.js --folder=output
//   node generate-html.js output            (positional, same effect)
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
      if (next !== undefined && !next.startsWith('--')) {
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

async function build() {
  const args = parseArgs(process.argv);
  const folderArg = (typeof args.flags.folder === 'string' && args.flags.folder) || args.positional[0];

  let inputDir;
  if (folderArg) {
    // Caller provided a folder — validate and use it directly, skip the picker.
    try {
      const stat = await fs.stat(folderArg);
      if (!stat.isDirectory()) {
        console.error(`❌ "${folderArg}" is not a directory.`);
        process.exit(1);
      }
    } catch {
      console.error(`❌ Folder "${folderArg}" not found.`);
      process.exit(1);
    }
    inputDir = folderArg;
  } else {
    const folders = await findFoldersWithMarkdown('.');
    if (folders.length === 0) {
      console.log('❌ Nothing to generate HTML for: no folders contain .md files.');
      console.log('👉 Run: pnpm run start');
      return;
    }
    inputDir = await pickFolder(folders);
  }
  const rawFiles = (await fs.readdir(inputDir)).filter((f) => f.endsWith('.md') && !MD_IGNORE_FILES.has(f));

  if (rawFiles.length === 0) {
    console.log(`❌ Nothing to generate HTML for: no .md files found in '${inputDir}'.`);
    return;
  }

  // Sort: the "main" page (first non-numeric alphabetically) goes first, then
  // numbered sub-pages in numeric order, then any other non-numeric pages
  // alphabetically. The browser sidebar follows insertion order, so this
  // controls the rendered nav order.
  const files = sortFilesForSidebar(rawFiles);

  const pages = {};

  for (const file of files) {
    const name = path.basename(file, '.md');
    const markdown = await fs.readFile(path.join(inputDir, file), 'utf-8');
    let html = marked(markdown);
    // Insert <hr class="section-divider"> after each h1, h2, h3
    html = html.replace(/(<h[1-3][^>]*>.*?<\/h[1-3]>)/g, '$1<hr class="section-divider">');
    // Sanitize the HTML output from marked, do not escape or wrap again
    let sanitized = sanitizeHtml(html, {
      allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'hr']),
      allowedAttributes: {
        ...sanitizeHtml.defaults.allowedAttributes,
        code: ['class'],
        img: ['src', 'alt'],
        hr: ['class'],
      },
      transformTags: {
        'a': (tagName, attribs) => {
          if (attribs.href && /^(https?:\/\/)/.test(attribs.href)) {
            return {
              tagName: 'a',
              attribs: {
                ...attribs,
                target: '_blank',
                rel: 'noopener noreferrer'
              }
            };
          }
          if (attribs.href && attribs.href.startsWith('/')) {
            return {
              tagName: 'a',
              attribs: {
                ...attribs,
                href: 'https://www.notion.so' + attribs.href,
                target: '_blank',
                rel: 'noopener noreferrer'
              }
            };
          }
          // Remove the link by returning an empty string (removes the tag and its content)
          return {
            tagName: false,
            text: ''
          };
        }
      }
    });
    // Wrap every <table> in a horizontally-scrollable container. Done after
    // sanitize so the wrapper class survives without changing sanitize config.
    sanitized = sanitized.replace(
      /<table[\s\S]*?<\/table>/g,
      (m) => `<div class="table-wrap">${m}</div>`
    );
    pages[name] = sanitized;
  }

  const finalHtml = generateHTML(pages);
  await fs.writeFile(inputDir + '/website.html', finalHtml);
  console.log(`✅ Site built: ${inputDir}/website.html`);
}

build().catch(console.error);
