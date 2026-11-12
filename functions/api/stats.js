const API_BASE = 'https://v3.football.api-sports.io';
const CACHE_SECONDS = 300;
const REQUEST_TIMEOUT_MS = 8_000;
const TOTAL_TIMEOUT_MS = 25_000;
const EVENT_CONCURRENCY = 2;
const MAX_EVENT_REQUESTS = 40;
const EVENT_SPACING_MS = 250;
const MAX_FIXTURE_PAGES = 3;
const FINISHED_STATUSES = new Set(['FT', 'AET', 'PEN']);
const STAT_KEYS = ['noGoals', 'min0To20', 'min21ToHalftime', 'min45To75', 'min76ToFinish'];

export async function onRequestGet({ request, env }) {
  if (!env.APIFOOTBALL_KEY) return json({ error: 'Match statistics are not configured. Add APIFOOTBALL_KEY to the Pages environment.' }, 503);
  const url = new URL(request.url);
  const date = url.searchParams.get('date') || '';
  const timezone = validTimezone(url.searchParams.get('timezone') || 'Europe/London');
  const forceRefresh = url.searchParams.get('refresh') === '1';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isRealDate(date)) return json({ error: 'Provide a valid date in YYYY-MM-DD format.' }, 400);

  const cacheKey = new Request(`${url.origin}/api/stats?v=2&date=${date}&timezone=${encodeURIComponent(timezone)}`);
  try {
    if (forceRefresh) await caches.default.delete(cacheKey);
    else {
      const cached = await caches.default.match(cacheKey);
      if (cached) return cached;
    }
  } catch { /* Edge cache is optional. */ }

  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  try {
    const diagnostics = { scoreUnavailable: 0, eventsMissing: 0, eventsInconsistent: 0, eventFailures: 0, eventRateLimited: 0, eventLimit: 0, fixturePagesMissing: 0, fixturePageFailures: 0 };
    const path = `/fixtures?date=${encodeURIComponent(date)}&timezone=${encodeURIComponent(timezone)}`;
    const first = await apiGet(path, env.APIFOOTBALL_KEY, deadline);
    const fixtures = [...first.response];
    let totalPages = first.totalPages;
    for (let page = 2; page <= Math.min(totalPages, MAX_FIXTURE_PAGES); page += 1) {
      try {
        const next = await apiGet(`${path}&page=${page}`, env.APIFOOTBALL_KEY, deadline);
        fixtures.push(...next.response);
        totalPages = Math.max(totalPages, next.totalPages);
      } catch {
        diagnostics.fixturePageFailures += 1;
        diagnostics.fixturePagesMissing = totalPages - page + 1;
        break;
      }
    }
    if (!diagnostics.fixturePagesMissing) diagnostics.fixturePagesMissing = Math.max(0, totalPages - MAX_FIXTURE_PAGES);
    const seen = new Set();
    const finished = fixtures.filter((item) => {
      if (!FINISHED_STATUSES.has(item?.fixture?.status?.short)) return false;
      const id = item?.fixture?.id;
      if (id == null) return true;
      if (seen.has(String(id))) return false;
      seen.add(String(id));
      return true;
    });
    const counts = Object.fromEntries(STAT_KEYS.map((key) => [key, 0]));
    let requests = 0;
    let quotaStopped = false;
    let nextEventAt = Date.now();
    await mapWithConcurrency(finished, EVENT_CONCURRENCY, async (fixture) => {
      const home = readGoalCount(fixture?.goals?.home);
      const away = readGoalCount(fixture?.goals?.away);
      if (home === null || away === null) { diagnostics.scoreUnavailable += 1; return; }
      if (home + away === 0) { counts.noGoals += 1; return; }
      const id = fixture?.fixture?.id;
      if (id == null) { diagnostics.eventsMissing += 1; return; }
      if (quotaStopped || requests >= MAX_EVENT_REQUESTS || Date.now() >= deadline) { diagnostics.eventLimit += 1; return; }
      requests += 1;
      const wait = Math.max(0, nextEventAt - Date.now());
      nextEventAt = Math.max(Date.now(), nextEventAt) + EVENT_SPACING_MS;
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      if (quotaStopped || Date.now() >= deadline) { diagnostics.eventLimit += 1; return; }
      try {
        const result = await apiGet(`/fixtures/events?fixture=${encodeURIComponent(id)}`, env.APIFOOTBALL_KEY, deadline);
        if (result.totalPages > 1) { diagnostics.eventsInconsistent += 1; return; }
        const goals = result.response.filter(isMatchGoal);
        if (!goals.length) { diagnostics.eventsMissing += 1; return; }
        if (goals.length !== home + away || !goals.every(validGoalTime) || !matchesTeams(goals, fixture, home, away)) {
          diagnostics.eventsInconsistent += 1;
          return;
        }
        goals.sort((a, b) => Number(a.time.elapsed) - Number(b.time.elapsed) || Number(a.time.extra || 0) - Number(b.time.extra || 0));
        classifyFirstGoal(Number(goals[0].time.elapsed), counts);
      } catch (error) {
        if (error.quota) { diagnostics.eventRateLimited += 1; quotaStopped = true; }
        else diagnostics.eventFailures += 1;
      }
    });
    const classifiedGames = STAT_KEYS.reduce((sum, key) => sum + counts[key], 0);
    const unclassifiedGames = finished.length - classifiedGames;
    const complete = unclassifiedGames === 0 && diagnostics.fixturePagesMissing === 0;
    const payload = { version: 2, date, timezone, scope: 'local-calendar-kickoff-day', finishedGames: finished.length, classifiedGames, unclassifiedGames, complete, diagnostics, counts, updatedAt: new Date().toISOString() };
    const result = json(payload, 200);
    if (complete) {
      try {
        const edgeResponse = json(payload, 200, { 'Cache-Control': `public, max-age=${CACHE_SECONDS}` });
        await caches.default.put(cacheKey, edgeResponse);
      } catch { /* Edge cache is optional. */ }
    }
    return result;
  } catch (error) {
    return json({ error: safeMessage(error) }, 502);
  }
}

function readGoalCount(value) {
  if (value === null || value === undefined || value === '') return null;
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 ? count : null;
}
function isMatchGoal(event) {
  if (event?.type !== 'Goal') return false;
  return !/missed penalty|goal cancelled|goal disallowed|annulled|penalty shootout/i.test(`${event.detail || ''} ${event.comments || ''}`);
}
function validGoalTime(event) {
  const elapsed = event?.time?.elapsed;
  const extra = event?.time?.extra;
  return elapsed !== null && elapsed !== undefined && elapsed !== '' && Number.isInteger(Number(elapsed)) && Number(elapsed) >= 0 &&
    (extra == null || (Number.isInteger(Number(extra)) && Number(extra) >= 0));
}
function matchesTeams(goals, fixture, home, away) {
  const homeId = fixture?.teams?.home?.id;
  const awayId = fixture?.teams?.away?.id;
  if (homeId == null || awayId == null || goals.some((goal) => goal?.team?.id == null)) return true;
  let homeEvents = 0;
  let awayEvents = 0;
  for (const goal of goals) {
    let team = goal.team.id;
    if (/own goal/i.test(goal.detail || '')) team = team === homeId ? awayId : team === awayId ? homeId : team;
    if (team === homeId) homeEvents += 1;
    else if (team === awayId) awayEvents += 1;
    else return false;
  }
  return homeEvents === home && awayEvents === away;
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
    while (next < items.length) await mapper(items[next++]);
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
async function apiGet(path, key, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('Provider request time limit reached.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(REQUEST_TIMEOUT_MS, remaining));
  try {
    const response = await fetch(`${API_BASE}${path}`, { headers: { 'x-apisports-key': key, Accept: 'application/json' }, signal: controller.signal });
    const payload = await response.json().catch(() => null);
    const errors = payload?.errors && typeof payload.errors === 'object' ? Object.values(payload.errors).filter(Boolean) : [];
    if (!response.ok || errors.length) {
      const error = new Error(errors.map(String).join(' · ') || `API-Football returned HTTP ${response.status}`);
      error.quota = response.status === 429 || /rate.?limit|quota|requests? limit|too many requests/i.test(error.message);
      throw error;
    }
    if (!payload || !Array.isArray(payload.response)) throw new Error('Invalid API-Football response.');
    const totalPages = payload.paging?.total;
    const currentPage = Number(new URL(`${API_BASE}${path}`).searchParams.get('page') || 1);
    if (!Number.isInteger(totalPages) || totalPages < 1 || payload.paging.current !== currentPage || currentPage > totalPages ||
        (payload.results != null && payload.results !== payload.response.length)) throw new Error('Invalid or incomplete API-Football pagination.');
    return { response: payload.response, totalPages };
  } finally { clearTimeout(timer); }
}
function safeMessage(error) {
  return error instanceof Error ? error.message.slice(0, 240) : 'The match statistics request failed.';
}
function json(value, status, extraHeaders = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extraHeaders } });
}
