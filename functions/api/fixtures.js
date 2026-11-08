const API_BASE = 'https://v3.football.api-sports.io';
const CACHE_SECONDS = 600;
const PREDICTION_CACHE_SECONDS = 12 * 60 * 60;
const PREDICTIONS_PER_WINDOW = 8;
const PREDICTION_BATCH_SIZE = 2;
const MAX_RETRIES = 4;
const REQUEST_TIMEOUT_MS = 10000;

export async function onRequestGet({ request, env }) {
  if (!env.APIFOOTBALL_KEY) {
    return json({ error: 'Fixture analysis is not configured. Add APIFOOTBALL_KEY to the Pages environment.' }, 503, { 'Cache-Control': 'no-store' });
  }

  const requestUrl = new URL(request.url);
  const day = requestUrl.searchParams.get('day') === '1' ? 1 : 0;
  const timezone = validTimezone(requestUrl.searchParams.get('timezone'));
  const now = new Date();
  const localNow = localDateTimeParts(now, timezone);
  const currentLocalDate = datePart(localNow);
  const baseDate = localNow.hour < 8 ? addCalendarDays(currentLocalDate, -1) : currentLocalDate;
  const startDate = addCalendarDays(baseDate, day);
  const endDate = addCalendarDays(startDate, 1);
  const start = localDateTimeToUtc(startDate, 8, timezone);
  const end = localDateTimeToUtc(endDate, 8, timezone);
  const cacheKey = new Request(`${new URL('/api/fixtures', request.url).origin}/api/fixtures?day=${day}&timezone=${encodeURIComponent(timezone)}&start=${encodeURIComponent(start.toISOString())}`);

  try {
    const cached = await caches.default.match(cacheKey);
    if (cached) return cached;
  } catch {
    // Continue if the edge cache is unavailable.
  }

  try {
    const dates = [startDate, endDate];
    const dailyResults = [];
    // Query dates sequentially to avoid bursts against the provider.
    for (const date of dates) {
      dailyResults.push(await apiGet(`/fixtures?date=${encodeURIComponent(date)}&timezone=${encodeURIComponent(timezone)}`, env.APIFOOTBALL_KEY));
    }

    const unique = new Map();
    dailyResults.flat().forEach((entry) => {
      if (entry?.fixture?.id !== undefined) unique.set(String(entry.fixture.id), entry);
    });
    const upcoming = [...unique.values()].filter((entry) => {
      const kickoff = new Date(entry?.fixture?.date).getTime();
      const status = entry?.fixture?.status?.short;
      return Number.isFinite(kickoff) && kickoff >= Math.max(now.getTime(), start.getTime()) && kickoff < end.getTime()
        && !['FT', 'AET', 'PEN', 'CANC', 'ABD', 'PST', 'SUSP'].includes(status);
    }).sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));

    // Prediction endpoints are one request per fixture. Enrich a small batch
    // only; cached fixture-list responses prevent repeated bursts, while all
    // matches remain visible with a clearly labelled baseline for the rest.
    const fixtures = await mapWithConcurrency(upcoming, PREDICTION_BATCH_SIZE, async (entry, index) => {
      let predictedTotal = null;
      if (index < PREDICTIONS_PER_WINDOW) {
        predictedTotal = await getCachedPrediction(entry.fixture.id, env.APIFOOTBALL_KEY, request.url).catch(() => null);
      }
      return {
        fixtureId: String(entry.fixture.id),
        kickoff: entry.fixture.date,
        homeTeam: entry.teams?.home?.name || 'Home',
        awayTeam: entry.teams?.away?.name || 'Away',
        league: entry.league?.name || 'Competition',
        country: entry.league?.country || '',
        over05Probability: estimateOver05(predictedTotal),
        probabilitySource: predictedTotal === null ? 'baseline' : 'provider prediction'
      };
    });

    const result = json({
      fixtures,
      generatedAt: now.toISOString(),
      window: { start: start.toISOString(), end: end.toISOString(), timezone, day }
    }, 200, {
      'Cache-Control': `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}`,
      'X-Content-Type-Options': 'nosniff'
    });
    try {
      await caches.default.put(cacheKey, result.clone());
    } catch {
      // Cache is an optimization; the response remains valid without it.
    }
    return result;
  } catch (error) {
    return json({ error: safeMessage(error) }, 502, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  }
}

async function getCachedPrediction(fixtureId, key, requestUrl) {
  const cacheKey = new Request(`${new URL('/api/fixture-prediction', requestUrl).origin}/api/fixture-prediction?id=${encodeURIComponent(fixtureId)}`);
  try {
    const cached = await caches.default.match(cacheKey);
    if (cached) {
      const payload = await cached.json();
      return Number.isFinite(payload.expectedGoals) ? payload.expectedGoals : null;
    }
  } catch {
    // Fetch fresh prediction if cache is unavailable.
  }

  const rows = await apiGet(`/predictions?fixture=${encodeURIComponent(fixtureId)}`, key);
  const expectedGoals = extractPredictedTotal(rows?.[0]);
  if (expectedGoals !== null) {
    try {
      await caches.default.put(cacheKey, json({ expectedGoals }, 200, {
        'Cache-Control': `public, max-age=${PREDICTION_CACHE_SECONDS}, s-maxage=${PREDICTION_CACHE_SECONDS}`
      }));
    } catch {
      // Continue if edge caching is unavailable.
    }
  }
  return expectedGoals;
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
  // Poisson approximation; baseline is explicitly marked when prediction data is unavailable.
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
      const message = errors.map(String).join(' · ') || `API-Football returned HTTP ${response.status}`;
      const limited = response.status === 429 || /rate limit|too many requests|quota/i.test(message);
      if (attempt < MAX_RETRIES && (limited || response.status >= 500 || response.status === 408)) {
        await sleep(limited ? Math.min(15000, 3000 * (attempt + 1)) : 500 * (2 ** attempt));
        continue;
      }
      throw new Error(message);
    } catch (error) {
      if (attempt < MAX_RETRIES && error instanceof Error && (error.name === 'AbortError' || /network|fetch|timeout/i.test(error.message))) {
        await sleep(500 * (2 ** attempt));
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('API-Football is unavailable after retries.');
}

function validTimezone(candidate) {
  try {
    const timezone = candidate || 'Europe/London';
    new Intl.DateTimeFormat('en', { timeZone: timezone });
    return timezone;
  } catch {
    return 'Europe/London';
  }
}

function localDateTimeParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]));
}

function datePart(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function addCalendarDays(dateString, amount) {
  const [year, month, day] = dateString.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + amount));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function localDateTimeToUtc(dateString, hour, timezone) {
  const [year, month, day] = dateString.split('-').map(Number);
  const target = Date.UTC(year, month - 1, day, hour);
  let guess = target;
  for (let i = 0; i < 3; i += 1) {
    const local = localDateTimeParts(new Date(guess), timezone);
    const represented = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
    guess += target - represented;
  }
  return new Date(guess);
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
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
