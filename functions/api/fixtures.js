const API_BASE = 'https://v3.football.api-sports.io';
const CACHE_SECONDS = 600;
const MAX_RETRIES = 4;
const REQUEST_TIMEOUT_MS = 10_000;
const PREDICTION_BATCH_SIZE = 2;
const MAX_PREDICTIONS_PER_WINDOW = 6;

export async function onRequestGet({ request, env }) {
  if (!env.APIFOOTBALL_KEY) {
    return json({ error: 'Fixture analysis is not configured. Add APIFOOTBALL_KEY to the Pages environment.' }, 503, { 'Cache-Control': 'no-store' });
  }

  const url = new URL(request.url);
  const day = Number(url.searchParams.get('day') || 0);
  const timezone = validTimezone(url.searchParams.get('timezone') || 'Europe/London');
  const now = new Date();
  const range = getLocalWindowForDay(now, timezone, day);

  try {
    const dateKeys = [...new Set([range.startDate, range.endDate])];
    const dailyResults = await Promise.all(dateKeys.map((dateKey) =>
      apiGet(`/fixtures?date=${encodeURIComponent(dateKey)}&timezone=${encodeURIComponent(timezone)}`, env.APIFOOTBALL_KEY)
    ));

    const byId = new Map();
    dailyResults.flat().forEach((entry) => {
      if (entry?.fixture?.id !== undefined) byId.set(String(entry.fixture.id), entry);
    });

    const upcoming = [...byId.values()].filter((entry) => {
      const kickoff = new Date(entry?.fixture?.date).getTime();
      const status = entry?.fixture?.status?.short;
      return Number.isFinite(kickoff) && kickoff >= range.startMs && kickoff < range.endMs
        && !['FT', 'AET', 'PEN', 'CANC', 'ABD', 'PST', 'SUSP'].includes(status);
    }).sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));

    const fixtures = [];
    for (let index = 0; index < upcoming.length; index += 1) {
      const entry = upcoming[index];
      let expectedGoals = null;
      if (index < MAX_PREDICTIONS_PER_WINDOW) {
        expectedGoals = await getExpectedGoals(entry.fixture.id, env.APIFOOTBALL_KEY).catch(() => null);
      }

      const homeTeam = entry.teams?.home?.name || 'Home';
      const awayTeam = entry.teams?.away?.name || 'Away';
      const modelExpectedGoals = expectedGoals ?? 1.65;
      const scorelines = buildScorelineSet(modelExpectedGoals);
      const over05Probability = estimateOver05(modelExpectedGoals);
      const over15Probability = estimateOver15(modelExpectedGoals);
      const zeroZeroRisk = scorelines.some((scoreline) => scoreline.label === '0-0');

      fixtures.push({
        fixtureId: String(entry.fixture.id),
        kickoff: entry.fixture.date,
        homeTeam,
        awayTeam,
        league: entry.league?.name || 'Competition',
        country: entry.league?.country || '',
        over05Probability,
        over15Probability,
        expectedTotalGoals: Number(modelExpectedGoals.toFixed(2)),
        highGoalPotential: over15Probability >= 60,
        probabilitySource: expectedGoals === null ? 'baseline' : 'provider prediction',
        scorelines,
        zeroZeroRisk
      });

      if (index % PREDICTION_BATCH_SIZE === 1) await sleep(250);
    }

    const result = json({
      fixtures,
      generatedAt: now.toISOString(),
      window: { start: range.startMs, end: range.endMs, timezone, day }
    }, 200, {
      'Cache-Control': `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}`,
      'X-Content-Type-Options': 'nosniff'
    });

    try {
      const cacheKey = new Request(`${url.origin}/api/fixtures?day=${day}&timezone=${encodeURIComponent(timezone)}`);
      await caches.default.put(cacheKey, result.clone());
    } catch {
      // Cache is an optimization; the response remains valid without it.
    }
    return result;
  } catch (error) {
    return json({ error: safeMessage(error) }, 502, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  }
}

function buildScorelineSet(expectedTotal) {
  const homeLambda = Math.max(0, Math.min(6, expectedTotal * 0.55));
  const awayLambda = Math.max(0, Math.min(6, expectedTotal * 0.45));
  const results = [];
  for (let home = 0; home <= 6; home += 1) {
    for (let away = 0; away <= 6; away += 1) {
      results.push({
        label: `${home}-${away}`,
        probability: poissonProbability(home, homeLambda) * poissonProbability(away, awayLambda) * 100
      });
    }
  }
  return results.sort((a, b) => b.probability - a.probability).slice(0, 3);
}

function poissonProbability(goals, expected) {
  let factorial = 1;
  for (let i = 2; i <= goals; i += 1) factorial *= i;
  return Math.exp(-expected) * (expected ** goals) / factorial;
}

async function getExpectedGoals(fixtureId, key) {
  const rows = await apiGet(`/predictions?fixture=${encodeURIComponent(fixtureId)}`, key);
  const prediction = rows?.[0];
  const goals = prediction?.predictions?.goals ?? prediction?.goals;
  if (!goals) return null;
  const home = parseGoalEstimate(goals.home);
  const away = parseGoalEstimate(goals.away);
  return home === null || away === null ? null : Math.max(0, Math.min(6, home + away));
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
  return Math.round((1 - Math.exp(-expectedGoals)) * 100);
}

function estimateOver15(expectedGoals) {
  return Math.round((1 - Math.exp(-expectedGoals) * (1 + expectedGoals)) * 100);
}

function validTimezone(candidate) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return 'Europe/London';
  }
}

function getLocalWindowForDay(now, timezone, dayOffset) {
  const parts = getLocalParts(now, timezone);
  const today = dateKey(now, timezone);
  const currentStartDate = parts.hour >= 8 ? today : addCalendarDays(today, -1);
  const startDate = addCalendarDays(currentStartDate, dayOffset);
  const endDate = addCalendarDays(startDate, 1);
  return {
    startDate,
    endDate,
    startMs: localDateTimeToUtc(startDate, 8, timezone).getTime(),
    endMs: localDateTimeToUtc(endDate, 8, timezone).getTime()
  };
}

function getLocalParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  const map = {};
  for (const part of parts) if (part.type !== 'literal') map[part.type] = part.value;
  return { year: Number(map.year), month: Number(map.month), day: Number(map.day), hour: Number(map.hour) };
}

function dateKey(date, timezone) {
  const { year, month, day } = getLocalParts(date, timezone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function addCalendarDays(value, amount) {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + amount));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function localDateTimeToUtc(dateValue, hour, timezone) {
  const [year, month, day] = dateValue.split('-').map(Number);
  const target = Date.UTC(year, month - 1, day, hour);
  let guess = target;
  for (let i = 0; i < 3; i += 1) {
    const local = getLocalParts(new Date(guess), timezone);
    const represented = Date.UTC(local.year, local.month - 1, local.day, local.hour);
    guess += target - represented;
  }
  return new Date(guess);
}

async function apiGet(path, key) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
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
        await sleep(limited ? Math.min(15_000, 2_000 * (attempt + 1)) : 500 * (2 ** attempt));
        continue;
      }
      throw new Error(message);
    } catch (error) {
      const retryable = error instanceof Error && (error.name === 'AbortError' || /network|fetch|timeout/i.test(error.message));
      if (retryable && attempt < MAX_RETRIES) {
        await sleep(500 * (2 ** attempt));
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }
  throw new Error('API-Football is unavailable after retries.');
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
