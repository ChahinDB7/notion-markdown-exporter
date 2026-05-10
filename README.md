# Notion Markdown Import and Exporter

Let's you export pages easily to your project in markdown format and also patch them back to Notion after adjusting them.

## Setup

1. Create a Notion integration and grab the access token:

   - Go to [Notion integrations](https://www.notion.so/profile/integrations/internal) and click **New connection**.
   - Give it a name (it will be installed into your own `"<Your Name>'s Notion"` workspace) and click **Create**.
   - Open **Configure connection settings**, then under **Installation access token** click **Show** and copy the token.

   - For exporting only, **Read content** permission is enough.
   - For pushing Markdown back into Notion (`pnpm patch`), also enable **Update content** and **Insert content** in the same Capabilities panel. *Update* is required to clear (archive) the existing blocks; *Insert* is required to add the new ones and to create sub-pages.
   - In the same page choose **Content access** at the top, click **Edit access**, and enable the page(s) you want to give the integration access to. Newly created sub-pages inherit access from their parent automatically — internal integrations cannot create top-level workspace pages.

2. Copy `.env.example` to `.env` and paste the token you just copied:

   ```sh
   cp .env.example .env
   ```

   Then open `.env` and set `NOTION_API_KEY` to your actual token.

3. Install dependencies:

   ```sh
   pnpm install
   ```

4. Export your Notion pages to Markdown:

   ```sh
   pnpm start
   ```

5. (Optional) Generate an HTML version from the Markdown:

   ```sh
   pnpm generate-html
   ```

6. (Optional) Push a Markdown file back into a Notion page (or into a brand-new sub-page):

   ```sh
   pnpm patch                                # fully interactive — pick a page (or "Create a new sub-page…") then a .md file then a mode
   pnpm patch -- 1 tradingbot.md             # non-interactive: page #1, output/tradingbot.md (asks for mode)
   pnpm patch -- 1 tradingbot.md --smart     # smart-patch (only adjust differences)
   pnpm patch -- 1 tradingbot.md --fresh     # clear-and-rebuild
   pnpm patch -- 1 tradingbot.md --dry-run   # parse + preview the block tree, no Notion writes
   pnpm patch -- --new "My Page" --parent 1 tradingbot.md   # create a new sub-page under page #1
   ```

   The patcher converts every `#`/`##`/`###` heading into a **toggleable** Notion heading and structurally nests `h2` inside its parent `h1`, `h3` inside its parent `h2`.

   **Smart vs Fresh:**
   - **Smart** compares the page's current block tree to the markdown-derived tree (LCS-based diff) and only writes the differences — kept blocks stay put, changed text is updated in place, missing blocks are inserted, extras are deleted. Best for small edits like adding a section or rephrasing a paragraph.
   - **Fresh** archives every block on the page and rebuilds it from scratch. Best when you've made big structural changes to the markdown.

   For a brand-new sub-page, the patcher just fills the empty page (mode question is skipped). Requires the integration to have **Read + Update + Insert content** permissions (see step 1).

## License

Released under the [MIT License](LICENSE).
