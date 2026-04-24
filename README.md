# Notion Markdown Exporter (with API)

I built this because I wanted to export my Notion pages to Markdown, and the other projects I tried kept producing Markdown with broken alignment and formatting. This one keeps the structure intact.

## Setup

1. Copy `.env.example` to `.env` and replace the placeholder with your Notion integration key:

   ```sh
   cp .env.example .env
   ```

   Then open `.env` and set `NOTION_API_KEY` to your actual key.

2. Install dependencies:

   ```sh
   pnpm install
   ```

3. Export your Notion pages to Markdown:

   ```sh
   pnpm start
   ```

4. (Optional) Generate an HTML version from the Markdown:

   ```sh
   pnpm generate-html
   ```

## License

Released under the [MIT License](LICENSE).
