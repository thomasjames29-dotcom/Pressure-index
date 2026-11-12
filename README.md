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

## First-goal statistics

The Stats tab requires the Cloudflare Pages Function `/api/stats` and the `APIFOOTBALL_KEY` secret above. A static GitHub Pages deployment alone cannot run this function. Deploy the site and functions together, then reload the app to install the updated service worker.

Stats use the selected **local calendar kickoff date**, midnight to midnight in the browser's timezone. This is different from the fixture dashboard's local 8am–8am windows. Only provider fixtures with FT, AET or PEN status are considered. A 0–0 final score is counted directly; scored games require usable goal events matching the score. Normal, own and penalty goals count; missed, disallowed and shootout goals do not. Minute 45 and 45+ are in 21–HT; 46–75 is the next bucket, and 76 onward includes extra time. PEN scores exclude the shootout. A missing score, missing or inconsistent events, or a failed request is never treated as goalless.

The provider may omit fixtures, scores, events or entire competitions, or return incomplete data even when a request succeeds. Matching events to the score cannot prove a feed is correct. The displayed finished count covers only returned fixtures; a complete result means only that all returned finished fixtures were classified and all reported fixture pages were fetched. It does not guarantee the provider's coverage is complete. An incomplete breakdown is biased towards goalless matches and must not be interpreted as the distribution of all games. The app reports counts and reasons for unclassified games and missing fixture pages.

To protect quota, only the selected day is fetched, with at most three fixture pages and 40 event requests, two concurrent events, 250 ms spacing, an 8-second request timeout and a 25-second overall budget. A rate-limit response stops further event requests. Dates with more scored games than the cap cannot be fully classified by this endpoint, even after refresh. Quotas and coverage vary by API-Football plan; repeated refreshes and multiple users consume the shared key's quota. The endpoint does not retry quota failures. Protect the public endpoint with suitable Cloudflare access controls/rate limiting if necessary.

Results and manual edits remain in browser-local storage and do not sync across devices. Older saved data, manual edits and data from another timezone are marked unverified. Select a day and press **Refresh results** to request fresh data; confirm replacement of unverified entries when prompted. A partial refresh will not replace any saved counts, because aggregate totals cannot establish which partial result covers more games; its diagnostics are shown instead. Clear the day first if you explicitly want to save the partial result. Complete results are cached at the edge for five minutes; refresh invalidates that entry and bypasses browser caching. Errors are not saved as empty days. The 7/30-day summaries include only complete, verified past days for the current timezone and report missing and excluded days; today is excluded because it is still in progress.

Run the mocked tests with Node.js 22 or later:

```sh
node --test tests/stats.test.mjs
```
