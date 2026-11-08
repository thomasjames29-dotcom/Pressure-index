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
    const dailyResults = await Promise.all(
      dateKeys.map((dateKey) => apiGet(`/fixtures?date=${encodeURIComponent(dateKey)}&timezone=${encodeURIComponent(timezone)}`, env.APIFOOTBALL_KEY))
    );

    const byId = new Map();
    dailyResults.flat().forEach((entry) => {
      if (entry?.fixture?.id !== undefined) byId.set(String(entry.fixture.id), entry);
    });

    const upcoming = [...byId.values()]
      .filter((entry) => {
        const kickoff = new Date(entry?.fixture?.date).getTime();
        const status = entry?.fixture?.status?.short;
        return Number.isFinite(kickoff)
          && kickoff >= range.startMs
          && kickoff < range.endMs
          && !['FT', 'AET', 'PEN', 'CANC', 'ABD', 'PST', 'SUSP'].includes(status);
      })
      .sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));

    const fixtures = [];
    for (let index = 0; index < upcoming.length; index += 1) {
      const entry = upcoming[index];
      let predictedTotal = null;
      if (index < MAX_PREDICTIONS_PER_WINDOW) {
        predictedTotal = await getPredictionTotal(entry.fixture.id, env.APIFOOTBALL_KEY).catch(() => null);
      }
      const scorelines = buildScorelineSet(predictedTotal, entry.teams?.home?.name || 'Home', entry.teams?.away?.name || 'Away');
      fixtures.push({
        fixtureId: String(entry.fixture.id),
        kickoff: entry.fixture.date,
        homeTeam: entry.teams?.home?.name || 'Home',
        awayTeam: entry.teams?.away?.name || 'Away',
        league: entry.league?.name || 'Competition',
        country: entry.league?.country || '',
        over05Probability: estimateOver05(predictedTotal),
        probabilitySource: predictedTotal === null ? 'baseline' : 'provider prediction',
        scorelines,
        zeroZeroRisk: scorelines.some((scoreline) => scoreline.label === '0-0')
      });
      if (index % PREDICTION_BATCH_SIZE === 1) {
        await sleep(250);
      }
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
      const cacheKey = new Request(`${new URL('/api/fixtures', request.url).origin}/api/fixtures?day=${day}&timezone=${encodeURIComponent(timezone)}`);
      await caches.default.put(cacheKey, result.clone());
    } catch {
      // Cache is an optimization; the response remains valid without it.
    }

    return result;
  } catch (error) {
    return json({ error: safeMessage(error) }, 502, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  }
}

function buildScorelineSet(expectedGoals, homeName, awayName) {
  const gHome = expectedGoals === null ? 1.3 : Math.max(0, expectedGoals * 0.55);
  const gAway = expectedGoals === null ? 1.0 : Math.max(0, expectedGoals * 0.45);
  const baseScores = [
    { label: '0-0', probability: poissonProbability(0, gHome) * poissonProbability(0, gAway) },
    { label: '1-0', probability: poissonProbability(1, gHome) * poissonProbability(0, gAway) },
    { label: '0-1', probability: poissonProbability(0, gHome) * poissonProbability(1, gAway) },
    { label: '1-1', probability: poissonProbability(1, gHome) * poissonProbability(1, gAway) },
    { label: '2-0', probability: poissonProbability(2, gHome) * poissonProbability(0, gAway) },
    { label: '0-2', probability: poissonProbability(0, gHome) * poissonProbability(2, gAway) },
    { label: '2-1', probability: poissonProbability(2, gHome) * poissonProbability(1, gAway) },
    { label: '1-2', probability: poissonProbability(1, gHome) * poissonProbability(2, gAway) },
    { label: '2-2', probability: poissonProbability(2, gHome) * poissonProbability(2, gAway) }
  ];
  const total = baseScores.reduce((sum, item) => sum + item.probability, 0) || 1;
  const sorted = baseScores
    .map((item) => ({ ...item, probability: (item.probability / total) * 100 }))
    .sort((a, b) => b.probability - a.probability)
    .slice(0, 3);
  return sorted.map((item) => ({ ...item, homeName, awayName }));
}

function poissonProbability(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  const e = Math.exp(-lambda);
  let prob = 1;
  for (let i = 1; i <= k; i += 1) prob *= lambda / i;
  return e * prob;
}

async function getPredictionTotal(fixtureId, key) {
  const predictionResponse = await apiGet(`/predictions?fixture=${encodeURIComponent(fixtureId)}`, key);
  const prediction = Array.isArray(predictionResponse) ? predictionResponse[0] : null;
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
  const total = expectedGoals === null ? 1.65 : Math.max(0, Math.min(6, expectedGoals));
  return Math.round((1 - Math.exp(-total)) * 100);
}

function validTimezone(candidate) {
  try {
    const tz = candidate || 'Europe/London';
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    return tz;
  } catch {
    return 'Europe/London';
  }
}

function getLocalWindowForDay(now, timezone, dayOffset) {
  const parts = getLocalParts(now, timezone);
  const currentStartDate = Number(parts.hour) >= 8 ? dateKey(now, timezone) : addCalendarDays(dateKey(now, timezone), -1);
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
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });
  const parts = formatter.formatToParts(date);
  const map = {};
  for (const part of parts) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute)
  };
}

function dateKey(date, timezone) {
  const parts = getLocalParts(date, timezone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function addCalendarDays(dateString, amount) {
  const [year, month, day] = dateString.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + amount));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function localDateTimeToUtc(dateString, hour, timezone) {
  const [year, month, day] = dateString.split('-').map(Number);
  const utcBase = Date.UTC(year, month - 1, day, hour);
  const offsetMinutes = getTimezoneOffsetMinutes(new Date(utcBase), timezone);
  return new Date(utcBase - offsetMinutes * 60_000);
}

function getTimezoneOffsetMinutes(date, timezone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    timeZoneName: 'shortOffset',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
  const token = formatter.formatToParts(date).find((part) => part.type === 'timeZoneName')?.value || 'GMT';
  const offset = token.replace('GMT', '').replace(/:/g, '');
  if (!offset || offset === '') return 0;
  const sign = offset.startsWith('-') ? -1 : 1;
  const digits = offset.replace(/[+-]/g, '');
  const hours = Number(digits.slice(0, 2) || 0);
  const minutes = Number(digits.slice(2, 4) || 0);
  return sign * (hours * 60 + minutes);
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
      const retriable = error instanceof Error && (error.name === 'AbortError' || /network|fetch|timeout/i.test(error.message));
      if (retriable && attempt < MAX_RETRIES) {
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
