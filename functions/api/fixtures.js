const API_BASE = 'https://v3.football.api-sports.io';
const CACHE_SECONDS = 240;
const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 10000;

export async function onRequestGet({ env }) {
  if (!env.APIFOOTBALL_KEY) {
    return json({ error: 'Fixture analysis is not configured. Add APIFOOTBALL_KEY to the Pages environment.' }, 503, { 'Cache-Control': 'no-store' });
  }

  const now = new Date();
  const end = new Date(now.getTime() + 48 * 60 * 60 * 1000);
  const fromDate = now.toISOString().slice(0, 10);
  const toDate = end.toISOString().slice(0, 10);

  try {
    const entries = await apiGet(`/fixtures?timezone=UTC&from=${fromDate}&to=${toDate}`, env.APIFOOTBALL_KEY);
    const upcoming = entries.filter((entry) => {
      const kickoff = new Date(entry?.fixture?.date).getTime();
      const status = entry?.fixture?.status?.short;
      return Number.isFinite(kickoff) && kickoff >= now.getTime() && kickoff <= end.getTime()
        && !['FT', 'AET', 'PEN', 'CANC', 'ABD', 'PST', 'SUSP'].includes(status);
    });

    const fixtures = await mapWithConcurrency(upcoming, 4, async (entry) => {
      const predictionRows = await apiGet(`/predictions?fixture=${encodeURIComponent(entry.fixture.id)}`, env.APIFOOTBALL_KEY).catch(() => []);
      const predictedTotal = extractPredictedTotal(predictionRows?.[0]);
      return {
        fixtureId: String(entry.fixture.id),
        kickoff: entry.fixture.date,
        homeTeam: entry.teams?.home?.name || 'Home',
        awayTeam: entry.teams?.away?.name || 'Away',
        league: entry.league?.name || 'Competition',
        country: entry.league?.country || '',
        over05Probability: estimateOver05(predictedTotal),
        probabilitySource: predictedTotal === null ? 'baseline estimate' : 'API-Football prediction'
      };
    });

    fixtures.sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
    return json({ fixtures, generatedAt: now.toISOString(), windowHours: 48 }, 200, {
      'Cache-Control': `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}`,
      'X-Content-Type-Options': 'nosniff'
    });
  } catch (error) {
    return json({ error: safeMessage(error) }, 502, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  }
}

function extractPredictedTotal(prediction) {
  const goals = prediction?.predictions?.goals ?? prediction?.goals;
  if (!goals) return null;
  const home = parseGoalEstimate(goals.home);
  const away = parseGoalEstimate(goals.away);
  return home === null || away === null ? null : home + away;
}

function parseGoalEstimate(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const match = value.match(/\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function estimateOver05(expectedGoals) {
  // Poisson approximation: P(at least one goal) = 1 - e^(-expected total goals).
  // When the provider has no usable estimate, expose a clearly documented neutral baseline.
  const total = expectedGoals === null ? 1.65 : Math.max(0, Math.min(6, expectedGoals));
  return Math.round((1 - Math.exp(-total)) * 100);
}

async function apiGet(path, key) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${API_BASE}${path}`, {
        headers: { 'x-apisports-key': key, Accept: 'application/json' },
        signal: controller.signal
      });
      const payload = await response.json().catch(() => ({}));
      const errors = payload.errors && typeof payload.errors === 'object' ? Object.values(payload.errors).filter(Boolean) : [];
      if (response.ok && errors.length === 0) return Array.isArray(payload.response) ? payload.response : [];
      const limited = response.status === 429 || errors.some((value) => /rate limit|too many requests|quota/i.test(String(value)));
      if (attempt < MAX_RETRIES && (limited || response.status >= 500 || response.status === 408)) {
        await sleep(limited ? 1000 * (attempt + 1) : 400 * (2 ** attempt));
        continue;
      }
      throw new Error(errors.join(' · ') || `API-Football returned HTTP ${response.status}`);
    } catch (error) {
      if (attempt < MAX_RETRIES && error instanceof Error && (error.name === 'AbortError' || /network|fetch|timeout/i.test(error.message))) {
        await sleep(400 * (2 ** attempt));
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('API-Football is unavailable after retries.');
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

function safeMessage(error) {
  return error instanceof Error ? error.message.slice(0, 240) : 'The fixture request failed.';
}

function json(value, status, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders }
  });
}
