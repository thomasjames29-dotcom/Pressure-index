# Pressure Index

A static HTML/CSS/JavaScript live-football dashboard with a Cloudflare Pages Function proxy. The proxy keeps the API-Football credential on the server and serves live fixtures and available match statistics to the table.

## Deploy as a real web app with Cloudflare Pages

1. **Rotate the API key you shared in chat** in your API-Football account before deployment. Treat that key as exposed; do not reuse it.
2. Push this repository to GitHub, then in Cloudflare choose **Workers & Pages → Create application → Pages → Connect to Git** and select `thomasjames29-dotcom/Pressure-index`.
3. Set the build command to no command (or `exit 0`) and the build output directory to `/`. The site files are at the repository root; the `functions/` directory is automatically deployed by Cloudflare Pages.
4. In the Pages project settings, add `APIFOOTBALL_KEY` as an encrypted secret/environment variable for Production (and Preview if required). Paste the rotated key there—not into GitHub, HTML, or JavaScript. Redeploy after adding it.
5. Open the Cloudflare Pages URL and verify that the live connection reports success. The dashboard calls its same-origin `/api/live` function, which calls API-Football from the server.

This repository change prepares the app for deployment, but does not publish it to Cloudflare: deployment requires signing into your Cloudflare account and authorizing the GitHub integration. Once connected, pushes to the configured production branch deploy automatically.

## Local development

Use the Cloudflare Pages dev server so the `/api/live` function is available. Install Node.js and Wrangler, set the secret locally without committing it, then run:

```sh
npm install --global wrangler
npx wrangler pages dev . --compatibility-date=2025-01-01
```

Set `APIFOOTBALL_KEY` in a local `.dev.vars` file before running the dev server. Never commit `.dev.vars`; it is intentionally not included in this repository. For example:

```text
APIFOOTBALL_KEY=your_rotated_api_key
```

## Live data and pressure score

The function requests `GET /fixtures?live=all`, then fetches each fixture's statistics with a concurrency limit of four. Successful aggregate responses are cached at the Cloudflare edge for 30 seconds; the browser refreshes once per minute. API consumption depends on the number of concurrent live fixtures and your API-Football plan. Monitor your plan quota, and use Cloudflare rate limiting or access controls if you need to restrict public traffic.

The 0–100 score is an explicitly heuristic ranking based on available total shots, shots on target, corners, dangerous attacks, and a small possession contribution, scaled by elapsed match time. Missing values are excluded. It indicates observed attacking activity; it is not a calibrated probability that a goal will happen. API-Football may omit live statistics for some games.

API documentation: https://www.api-football.com/documentation-v3
