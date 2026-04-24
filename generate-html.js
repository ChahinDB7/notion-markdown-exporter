import fs from 'fs/promises';
import path from 'path';
import sanitizeHtml from 'sanitize-html';
import escapeHtml from 'escape-html';
import { marked } from 'marked';

const inputDir = './output';

function escapeForJs(str) {
  // Escape backslashes, backticks, and ${ to prevent template injection
  return str
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
}

function generateHTML(pages) {
  const pageNames = Object.keys(pages);

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
    .content h1, .content h2, .content h3, .content h4, .content h5, .content h6 {
      color: #ffffff;
    }
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
    .content table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 2em;
      overflow-x: auto;
      display: block;
      max-width: 100%;
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
      .content table, .content thead, .content tbody, .content th, .content td, .content tr {
        display: block;
        width: 100%;
      }
      .content thead {
        display: none;
      }
      .content tr {
        margin-bottom: 1em;
        border-bottom: 2px solid #2a2a2a;
      }
      .content td {
        position: relative;
        padding-left: 50%;
        min-height: 2.5em;
      }
      .content td:before {
        position: absolute;
        top: 0;
        left: 0;
        width: 48%;
        padding-left: 1em;
        white-space: nowrap;
        font-weight: bold;
        color: #b8b8b8;
        content: attr(data-label);
      }
    }
  </style>
</head>
<body>
  <div class="sidebar" id="sidebar"></div>
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

    function loadPage(title) {
      const content = pages[title] || "<p>Page not found.</p>";
      document.getElementById("content").innerHTML = content;

      // Highlight current
      document.querySelectorAll(".nav-item").forEach(el => el.classList.remove("active"));
      const currentNav = document.getElementById("nav-" + title);
      if (currentNav) currentNav.classList.add("active");
    }

    function renderSidebar() {
      const sidebar = document.getElementById("sidebar");
      sidebar.innerHTML = "";

      Object.keys(pages).forEach(title => {
        const html = pages[title];
        let displayTitle = extractFirstH1(html);
        if (!displayTitle) {
          displayTitle = kebabToTitle(title);
        }
        const link = document.createElement("a");
        link.textContent = displayTitle;
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
      const firstPage = Object.keys(pages)[0];
      loadPage(firstPage);
    };
  </script>
</body>
</html>
`.trim();
}


async function build() {
  // Check if output folder exists
  try {
    await fs.access(inputDir);
  } catch (err) {
    console.log(`❌ Nothing to generate HTML for: '${inputDir}' folder does not exist.`);
    console.log('👉 Run: pnpm run start');
    return;
  }

  // Only include .md files
  const files = (await fs.readdir(inputDir)).filter((f) => f.endsWith('.md'));

  if (files.length === 0) {
    console.log(`❌ Nothing to generate HTML for: No .md files found in '${inputDir}'.`);
    console.log('👉 Run: pnpm run start');
    return;
  }

  const pages = {};

  for (const file of files) {
    const name = path.basename(file, '.md');
    const markdown = await fs.readFile(path.join(inputDir, file), 'utf-8');
    let html = marked(markdown);
    // Insert <hr class="section-divider"> after each h1, h2, h3
    html = html.replace(/(<h[1-3][^>]*>.*?<\/h[1-3]>)/g, '$1<hr class="section-divider">');
    // Sanitize the HTML output from marked, do not escape or wrap again
    pages[name] = sanitizeHtml(html, {
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
  }

  const finalHtml = generateHTML(pages);
  await fs.writeFile(inputDir + '/website.html', finalHtml);
  console.log(`✅ Site built: ${inputDir}/website.html`);
}

build().catch(console.error);
