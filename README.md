# Notion Markdown Exporter (with API)

I built this because I wanted to export my Notion pages to Markdown, and the other projects online I tried kept producing Markdown with broken alignment and formatting. This one keeps the structure intact.

## Setup

1. Create a Notion integration and grab the access token:

   - Go to [Notion integrations](https://www.notion.so/profile/integrations/internal) and click **New connection**.
   - Give it a name (it will be installed into your own `"<Your Name>'s Notion"` workspace) and click **Create**.
   - Open **Configure connection settings**, then under **Installation access token** click **Show** and copy the token.
   - Only **read content** permission is required.

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

## License

Released under the [MIT License](LICENSE).
