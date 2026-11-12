const API_BASE = 'https://v3.football.api-sports.io';
const CACHE_SECONDS = 300;
const REQUEST_TIMEOUT_MS = 10_000;
const EVENT_CONCURRENCY = 2;
const FINISHED_STATUSES = new Set(['FT', 'AET', 'PEN']);
const STAT_KEYS = ['noGoals', 'min0To20', 'min21ToHalftime', 'min45To75', 'min76ToFinish'];

export async function onRequestGet({ request, env }) {
  if (!env.APIFOOTBALL_KEY) return json({ error: 'Match statistics are not configured. Add APIFOOTBALL_KEY to the Pages environment.' }, 503);

  const url = new URL(request.url);
  const date = url.searchParams.get('date') || '';
  const timezone = validTimezone(url.searchParams.get('timezone') || 'Europe/London');
  const forceRefresh = url.searchParams.get('refresh') === '1';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isRealDate(date)) {
    return json({ error: 'Provide a valid date in YYYY-MM-DD format.' }, 400);
  }

  const cacheKey = new Request(`${url.origin}/api/stats?date=${date}&timezone=${encodeURIComponent(timezone)}`);
  if (!forceRefresh) {
    try {
      const cached = await caches.default.match(cacheKey);
      if (cached) return cached;
    } catch { /* Continue if edge cache is unavailable. */ }
  }

  try {
    const fixtures = await apiGet(`/fixtures?date=${encodeURIComponent(date)}&timezone=${encodeURIComponent(timezone)}`, env.APIFOOTBALL_KEY);
    const finished = fixtures.filter((item) => FINISHED_STATUSES.has(item?.fixture?.status?.short));
    const counts = Object.fromEntries(STAT_KEYS.map((key) => [key, 0]));
    let unclassified = 0;

    await mapWithConcurrency(finished, EVENT_CONCURRENCY, async (fixture) => {
      const homeGoals = readGoalCount(fixture?.goals?.home);
      const awayGoals = readGoalCount(fixture?.goals?.away);
      if (homeGoals === null || awayGoals === null) {
        unclassified += 1;
        return;
      }

      const expectedGoalEvents = homeGoals + awayGoals;
      if (expectedGoalEvents === 0) {
        counts.noGoals += 1;
        return;
      }

      const fixtureId = fixture?.fixture?.id;
      if (fixtureId === undefined) {
        unclassified += 1;
        return;
      }

      try {
        const events = await apiGet(`/fixtures/events?fixture=${encodeURIComponent(fixtureId)}`, env.APIFOOTBALL_KEY);
        const goals = events
          .filter(isMatchGoal)
          .sort((a, b) => goalElapsedMinute(a) - goalElapsedMinute(b));

        // The score is authoritative, but only classify when the event feed accounts
        // for every goal. Missing/extra events must not silently skew first-goal bins.
        if (goals.length !== expectedGoalEvents) {
          unclassified += 1;
          return;
        }
        classifyFirstGoal(goalElapsedMinute(goals[0]), counts);
      } catch {
        unclassified += 1;
      }
    });

    const classifiedGames = STAT_KEYS.reduce((sum, key) => sum + counts[key], 0);
    const result = json({
      date,
      timezone,
      finishedGames: finished.length,
      classifiedGames,
      unclassifiedGames: unclassified,
      counts,
      updatedAt: new Date().toISOString()
    }, 200, {
      'Cache-Control': forceRefresh ? 'no-store' : `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}`,
      'X-Content-Type-Options': 'nosniff'
    });
    if (!forceRefresh) {
      try { await caches.default.put(cacheKey, result.clone()); } catch { /* Optional edge cache. */ }
    }
    return result;
  } catch (error) {
    return json({ error: safeMessage(error) }, 502, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  }
}

function readGoalCount(value) {
  if (value === null || value === undefined || value === '') return null;
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 ? count : null;
}
function isMatchGoal(event) {
  if (event?.type !== 'Goal' || !Number.isInteger(Number(event?.time?.elapsed)) || Number(event.time.elapsed) < 1) return false;
  const detail = `${event.detail || ''} ${event.comments || ''}`;
  return !/missed penalty|goal cancelled|goal disallowed|annulled|penalty shootout/i.test(detail);
}
function goalElapsedMinute(event) {
  // Elapsed 45 (including 45+ stoppage) is first-half time; elapsed 46 starts half two.
  return Number(event?.time?.elapsed);
}
function classifyFirstGoal(minute, counts) {
  if (minute <= 20) counts.min0To20 += 1;
  else if (minute <= 45) counts.min21ToHalftime += 1;
  else if (minute <= 75) counts.min45To75 += 1;
  else counts.min76ToFinish += 1;
}
function isRealDate(value) {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
function validTimezone(candidate) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date()); return candidate; }
  catch { return 'Europe/London'; }
}
async function mapWithConcurrency(items, limit, mapper) {
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      await mapper(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
async function apiGet(path, key) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      headers: { 'x-apisports-key': key, Accept: 'application/json' },
      signal: controller.signal
    });
    const payload = await response.json().catch(() => ({}));
    const errors = payload.errors && typeof payload.errors === 'object' ? Object.values(payload.errors).filter(Boolean) : [];
    if (!response.ok || errors.length) {
      throw new Error(errors.map(String).join(' · ') || `API-Football returned HTTP ${response.status}`);
    }
    return Array.isArray(payload.response) ? payload.response : [];
  } finally { clearTimeout(timer); }
}
function safeMessage(error) {
  return error instanceof Error ? error.message.slice(0, 240) : 'The match statistics request failed.';
}
function json(value, status, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders }
  });
}
