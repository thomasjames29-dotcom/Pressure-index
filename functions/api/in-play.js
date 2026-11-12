import { analyzeInPlay, isPriorityLeague } from '../../lib/inplay-model.mjs';

const API_BASE = 'https://v3.football.api-sports.io';
const LIST_CACHE_SECONDS = 20;
const MAX_BATCH = 8;
const CONCURRENCY = 2;
const TIMEOUT_MS = 10000;

export async function onRequestGet({ request, env }) {
  if (!env.APIFOOTBALL_KEY) return json({ error: 'In-play analysis is not configured.' }, 503);
  try {
    const fixtures = await getEligibleFixtures(request.url, env.APIFOOTBALL_KEY);
    return json({
      fixtures: fixtures.map((item) => ({ id: String(item.fixture.id), priority: isPriorityLeague(item.league?.id) })),
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function onRequestPost({ request, env }) {
  if (!env.APIFOOTBALL_KEY) return json({ error: 'In-play analysis is not configured.' }, 503);
  let payload;
  try { payload = await request.json(); } catch { return json({ error: 'Provide a JSON list of fixture IDs.' }, 400); }
  const ids = payload?.ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_BATCH
    || ids.some((id) => typeof id !== 'string' || !/^[1-9]\d{0,14}$/.test(id))
    || new Set(ids).size !== ids.length) {
    return json({ error: `Provide between 1 and ${MAX_BATCH} distinct fixture IDs.` }, 400);
  }

  try {
    const fixtures = await getEligibleFixtures(request.url, env.APIFOOTBALL_KEY);
    const byId = new Map(fixtures.map((item) => [String(item.fixture.id), item]));
    const results = new Array(ids.length);
    let next = 0;
    let fatal = null;
    async function worker() {
      while (!fatal) {
        const index = next++;
        if (index >= ids.length) return;
        const fixture = byId.get(ids[index]);
        if (!fixture) {
          results[index] = { id: ids[index], error: 'Match is no longer eligible or live.' };
          continue;
        }
        try {
          const stats = await apiGet(`/fixtures/statistics?fixture=${encodeURIComponent(ids[index])}`, env.APIFOOTBALL_KEY);
          let events = null;
          let eventsError = null;
          try { events = await apiGet(`/fixtures/events?fixture=${encodeURIComponent(ids[index])}`, env.APIFOOTBALL_KEY); }
          catch (error) {
            if (error.rateLimited || error.providerAuth) throw error;
            eventsError = 'Recent events unavailable.';
          }
          const match = analyzeInPlay(fixture, stats, events, new Date().toISOString());
          results[index] = match ? { match, eventsError } : { id: ids[index], error: 'Insufficient shot statistics for both teams.' };
        } catch (error) {
          if (error.rateLimited || error.providerAuth) { fatal = error; return; }
          results[index] = { id: ids[index], error: 'Live statistics unavailable.' };
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));
    if (fatal) throw fatal;
    return json({ results });
  } catch (error) {
    return errorResponse(error);
  }
}

async function getEligibleFixtures(origin, key) {
  const cacheKey = new Request(new URL('/api/in-play-fixture-snapshot', origin));
  let fixtures;
  try {
    const cached = await caches.default.match(cacheKey);
    if (cached) fixtures = await cached.json();
  } catch { /* Fetch when the optional cache is unavailable. */ }
  if (!Array.isArray(fixtures)) {
    fixtures = await apiGet('/fixtures?live=all', key);
    try {
      await caches.default.put(cacheKey, new Response(JSON.stringify(fixtures), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${LIST_CACHE_SECONDS}` }
      }));
    } catch { /* Continue without cache. */ }
  }
  const unique = new Map();
  for (const item of fixtures) {
    const id = String(item?.fixture?.id ?? '');
    const elapsed = item?.fixture?.status?.elapsed;
    if (/^[1-9]\d{0,14}$/.test(id) && ['1H', '2H'].includes(item.fixture.status?.short)
      && Number.isFinite(Number(elapsed)) && elapsed !== null && elapsed !== ''
      && Number(elapsed) >= 10 && Number(elapsed) <= 80) unique.set(id, item);
  }
  return [...unique.values()].sort((a, b) => Number(a.fixture.id) - Number(b.fixture.id));
}

async function apiGet(path, key) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      headers: { 'x-apisports-key': key, Accept: 'application/json' },
      signal: controller.signal
    });
    const payload = await response.json().catch(() => null);
    const errors = payload?.errors && typeof payload.errors === 'object' ? Object.values(payload.errors).filter(Boolean).map(String) : [];
    if (!response.ok || errors.length) {
      const error = new Error(errors.join(' · ') || `Provider returned HTTP ${response.status}`);
      error.rateLimited = response.status === 429 || errors.some((value) => /rate.limit|too many requests|quota|request limit/i.test(value));
      error.providerAuth = response.status === 401 || response.status === 403
        || errors.some((value) => /invalid.*(?:key|token)|(?:key|token).*invalid|subscription/i.test(value));
      throw error;
    }
    if (!Array.isArray(payload?.response)) throw new Error('Provider returned an invalid response.');
    return payload.response;
  } finally { clearTimeout(timer); }
}

function errorResponse(error) {
  if (error?.rateLimited) return json({ error: 'Provider rate limit or quota reached. Please try again later.' }, 429);
  if (error?.providerAuth) return json({ error: 'Provider credentials or subscription do not allow this request.' }, 502);
  return json({ error: 'Could not load live fixtures from the provider.' }, 502);
}
function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
  });
}
