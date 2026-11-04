# Pressure Index

A small static live-football dashboard that fetches API-Football live fixtures and fixture statistics, then ranks matches by a transparent attacking-pressure heuristic.

## Run locally

Serve the repository with any static web server (for example `python3 -m http.server 8000`) and open `http://localhost:8000`. Enter an API-Football key in the page to connect. The key is held in JavaScript memory only; it is not written to local storage, the URL, or this repository. Disconnect clears it.

## Deploying publicly

The browser must send the API key to API-Football, so a key entered in the page can be inspected by the person using that browser and may be exposed to browser extensions or network tooling. Do not hard-code a real key in `app.js`, HTML, or a public GitHub repository. For a public audience, add a small backend/serverless proxy, store the API key in a server-side environment secret, and have the frontend call that proxy. Restrict the key in your API provider account if available.

## Data and score

The app calls `GET /fixtures?live=all`, then `GET /fixtures/statistics?fixture={id}` for each live fixture. It refreshes once per minute and displays API-returned live data. The pressure score uses available total shots, shots on target, corners, dangerous attacks, and a deliberately small possession contribution, with cumulative stats scaled by elapsed match time. Missing statistics are omitted from the calculation. The score is a descriptive heuristic—not a probability of a goal or a guarantee of prediction accuracy. API request consumption scales with the number of live matches because statistics are requested per fixture.

API documentation: https://www.api-football.com/documentation-v3
