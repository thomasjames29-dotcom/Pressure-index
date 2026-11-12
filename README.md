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

In **In-play analysis**, press **Refresh live sweep** to screen at most 32 eligible first- or second-half matches between minutes 10 and 80. Major international competitions and prominent domestic leagues are prioritized using the league IDs in `lib/inplay-model.mjs`. If other leagues are active, up to 24 places are reserved for these high-profile matches and the remaining places go to others; unused places are filled from either group. Subsequent sweeps rotate through overflow within each group. This curated list is a practical approximation of popularity, not live audience data. The app reports coverage, missing data and incomplete sweeps; it does not automatically refresh this view.

The sweep fetches the live fixture list (cached at the edge for 20 seconds when available), then requests statistics and, where usable, events in batches of eight, with one upstream request in flight and at least 250 ms between provider calls per server request. This pacing is per request, not a global limiter across concurrent users. A full 32-match sweep can use up to 65 provider requests with a warm fixture cache, or more if the snapshot expires between batches. Provider limits, unavailable edge caching, errors, and other users affect usage; monitor quota and configure Cloudflare rate limiting or access controls for the public endpoint. Completed results remain visible if the provider limits requests, including when event data is unavailable. The browser retries short-term or unspecified rate limits up to twice using the provider's `Retry-After` header when present; a reported daily limit stops the sweep. The provider may enforce per-minute limits separately from the daily quota.

On a provider limit, the page reports the affected endpoint and, when the provider supplies rate-limit headers, whether the configured key has daily and per-minute headroom. It does not expose the key, account details, or numeric quota values. The same sanitized diagnostic is logged in Cloudflare; `unknown` means the provider did not supply a usable header. These headers are provider-reported snapshots and may not explain every 429.

The 0–100 pressure score is a heuristic based on available match-to-date shots, shots on target, corners, dangerous attacks and xG, scaled by elapsed time. Missing metrics are excluded, not treated as zero; a match needs shots or shots on target for both teams. If the browser has a comparable earlier sweep, the ranking blends pressure with changes in shots, shots on target and corners over 3–20 minutes of playing time. Recent goals and red cards are displayed as context, not scored. Sampling times differ across batches, data may be delayed or incomplete, and a ten-minute playing window can cross half-time. The score is **not a calibrated probability** of a goal or evidence of predictive accuracy; simulations or stronger accuracy claims require historical event-level backtesting.

## Backtest fixture probabilities

In **Fixture analysis**, choose a league shown in the selected fixture window and a season starting year, then press **Run calibration**. The app saves the fitted over-0.5 factor in this browser only when there are at least 100 training and 40 held-out fixtures and both held-out Brier score and log loss improve. Otherwise the existing factor is kept. **Clear saved calibration** removes all factors from this browser.

The factor applies only to fixtures in the same or following season whose kickoff is after the replay's latest assumed result-availability time, provided the model version matches. Fixtures using xG are excluded because historical xG is not evaluated; the factor is also skipped if it would make over-0.5 less likely than the uncalibrated over-1.5. Calibrated over-0.5 and 0-0 probabilities are marked on the card; other estimates, including over-1.5 probabilities, first-goal timing, fair odds and order recommendations, remain uncalibrated. The data and thresholds are not a guarantee of future performance. Increment `FIXTURE_MODEL_VERSION` when changing the goal model to invalidate old browser factors and cached replays.

The calibration endpoint uses the server's `APIFOOTBALL_KEY` without exposing it to the browser. Results are cached at the edge for 12 hours per league and season, but new requests consume API quota; protect or rate-limit the endpoint in Cloudflare when making the app public.

Alternatively, run an opt-in historical replay from the command line to evaluate the over-0.5 and over-1.5 models by league and season:

```sh
node --env-file=.dev.vars scripts/calibrate-fixtures.mjs 39:2025 140:2025 > calibration-report.json
```

This uses Node.js 20.6 or newer and the local `.dev.vars` file described above. Alternatively, set `APIFOOTBALL_KEY` in the environment and omit `--env-file`; don't put the key in command history or commit it. Each league-season pair makes one API-Football fixtures request. The replay reconstructs standings and form from full-time scores; historical xG is not available in this feed, so it cannot evaluate the xG branch. It conservatively assumes results become available 24 hours after kickoff; the provider does not supply an actual result-availability timestamp, so unusually delayed results can still cause look-ahead. For each season, approximately the first 70% fit an over-0.5 log-odds intercept, and the rest report held-out Brier score, log loss, and probability bins. Training results unavailable by the holdout's first kickoff are excluded, and pooled results use a separate chronological split. League-season calibrators are omitted when there are fewer than 30 training fixtures.

The five-match shrinkage prior and other model weights are heuristic, not fitted. Command-line reports do not update the browser or a shared production model. The replay does not evaluate in-play goal timing or betting returns.

API documentation: https://www.api-football.com/documentation-v3
