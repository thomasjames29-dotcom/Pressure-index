const API_BASE = 'https://v3.football.api-sports.io';
const CACHE_SECONDS = 300;
const MAX_RETRIES = 4;
const REQUEST_TIMEOUT_MS = 12_000;
const BASE_BACKOFF_MS = 500;

export async function onRequestGet({ request, env }) {
  if (!env.APIFOOTBALL_KEY) {
    return json({ error: 'Fixture analysis service is not configured.' }, 503, { 'Cache-Control': 'no-store' });
  }

  const url = new URL(request.url);
  const from = url.searchParams.get('from') || new Date(Date.now()).toISOString();
  const to = url.searchParams.get('to') || new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

  try {
    const fixtures = await apiGet(`/fixtures?timezone=UTC&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, env.APIFOOTBALL_KEY);
    const upcoming = fixtures.filter((entry) => {
      const status = entry?.fixture?.status?.short;
      return entry?.fixture && status && !['FT', 'AET', 'PEN', 'CANC', 'ABD', 'POSTPONED', 'SUSP'].includes(status);
    });

    const analyzed = await mapWithConcurrency(upcoming.slice(0, 80), 4, async (entry) => {
      const fixtureId = entry.fixture.id;
      const predictionResult = await apiGet(`/predictions?fixture=${encodeURIComponent(fixtureId)}`, env.APIFOOTBALL_KEY).catch(() => []);
      const prediction = Array.isArray(predictionResult) ? predictionResult[0] : null;
      const expectedTotal = getExpectedGoalsTotal(prediction);
      const probability = estimateOver05Probability(expectedTotal);
      const kickoff = entry.fixture.date;
      const hoursToKickoff = (new Date(kickoff) - new Date()) / (1000 * 60 * 60);

      return {
        fixtureId: String(fixtureId),
        kickoff,
        windowLabel: hoursToKickoff <= 24 ? '0-24h' : '24-48h',
        homeTeam: entry.teams?.home?.name || 'Home',
        awayTeam: entry.teams?.away?.name || 'Away',
        league: entry.league?.name || 'Competition',
        country: entry.league?.country || '',
        over05Probability: Math.round(probability)
      };
    });

    const sorted = analyzed.sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
    return json({ fixtures: sorted }, 200, {
      'Cache-Control': `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}`,
      'X-Content-Type-Options': 'nosniff'
    });
  } catch (error) {
    return json({ error: safeMessage(error) }, 502, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  }
}

async function apiGet(path, key) {
  let attempt = 0;

  while (attempt <= MAX_RETRIES) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${API_BASE}${path}`, {
        headers: { 'x-apisports-key': key, Accept: 'application/json' },
        signal: controller.signal
      });
      const payload = await response.json().catch(() => ({}));
      const errors = payload.errors && typeof payload.errors === 'object' ? Object.values(payload.errors).filter(Boolean) : [];
      const isRateLimited = response.status === 429 || errors.some((message) => typeof message === 'string' && /rate limit|too many requests|quota/i.test(message));
      const shouldRetry = response.status >= 500 || response.status === 408 || isRateLimited;

      if (isRateLimited && attempt < MAX_RETRIES) {
        await sleep(rateLimitBackoffMs(attempt));
        attempt += 1;
        continue;
      }

      if (!response.ok || errors.length) {
        if (shouldRetry && attempt < MAX_RETRIES) {
          await sleep(backoffMs(attempt));
          attempt += 1;
          continue;
        }
        throw new Error(errors.join(' · ') || `API-Football returned HTTP ${response.status}`);
      }

      return Array.isArray(payload.response) ? payload.response : [];
    } catch (error) {
      const retriable = error instanceof Error && (error.name === 'AbortError' || /network|fetch|timeout/i.test(error.message));
      if (retriable && attempt < MAX_RETRIES) {
        await sleep(backoffMs(attempt));
        attempt += 1;
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw new Error('API-Football is unavailable after retries.');
}

function getExpectedGoalsTotal(prediction) {
  const home = Number.parseFloat(prediction?.goals?.home ?? prediction?.comparison?.home ?? prediction?.form?.home ?? '0');
  const away = Number.parseFloat(prediction?.goals?.away ?? prediction?.comparison?.away ?? prediction?.form?.away ?? '0');
  if (Number.isFinite(home) && Number.isFinite(away)) {
    return home + away;
  }
  return 1.6;
}

function estimateOver05Probability(expectedTotal) {
  const adjusted = Math.max(0.4, Number.isFinite(expectedTotal) ? expectedTotal : 1.6);
  const raw = 48 + (adjusted - 1.2) * 35;
  return Math.min(95, Math.max(24, raw));
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt) {
  return BASE_BACKOFF_MS * (2 ** attempt) + Math.random() * 250;
}

function rateLimitBackoffMs(attempt) {
  return Math.max(1000, backoffMs(attempt));
}

function safeMessage(error) {
  return error instanceof Error ? error.message.slice(0, 240) : 'The fixture analysis request failed.';
}

function json(value, status, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders }
  });
}
