import { analyzeInPlay, isPriorityLeague } from '../../lib/inplay-model.mjs';

const API_BASE = 'https://v3.football.api-sports.io';
const LIST_CACHE_SECONDS = 20;
const MAX_BATCH = 8;
const MAX_EVENT_ENRICHMENTS_PER_BATCH = 2;
const PROVIDER_REQUEST_INTERVAL_MS = 250;
const TIMEOUT_MS = 10000;

export async function onRequestGet({ request, env }) {
  if (!env.APIFOOTBALL_KEY) return json({ error: 'In-play analysis is not configured.' }, 503);
  try {
    const fixtures = await getEligibleFixtures(request.url, env.APIFOOTBALL_KEY, createProviderPacer());
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
  const includeEvents = payload.includeEvents !== false;

  try {
    const paceProviderRequests = createProviderPacer();
    const fixtures = await getEligibleFixtures(request.url, env.APIFOOTBALL_KEY, paceProviderRequests);
    const byId = new Map(fixtures.map((item) => [String(item.fixture.id), item]));
    const results = new Array(ids.length);
    const analyzable = [];
    let fatal = null;
    for (let index = 0; index < ids.length; index += 1) {
      const fixture = byId.get(ids[index]);
      if (!fixture) {
        results[index] = { id: ids[index], error: 'Match is no longer eligible or live.' };
        continue;
      }
      try {
        const stats = await apiGet(`/fixtures/statistics?fixture=${encodeURIComponent(ids[index])}`, env.APIFOOTBALL_KEY, paceProviderRequests);
        const observedAt = new Date().toISOString();
        const match = analyzeInPlay(fixture, stats, null, observedAt);
        if (!match) {
          results[index] = { id: ids[index], error: 'Insufficient shot statistics for both teams.' };
          continue;
        }
        results[index] = { match: { ...match, eventsSkipped: true } };
        analyzable.push({ index, fixture, stats, observedAt });
      } catch (error) {
        if (error.rateLimited || error.providerAuth) { fatal = error; break; }
        results[index] = { id: ids[index], error: 'Live statistics unavailable.' };
      }
    }

    let eventLimit = null;
    if (!fatal && includeEvents) {
      const eventCandidates = [...analyzable]
        .sort((a, b) => results[b.index].match.pressure - results[a.index].match.pressure || a.index - b.index)
        .slice(0, MAX_EVENT_ENRICHMENTS_PER_BATCH);
      for (const candidate of eventCandidates) {
        delete results[candidate.index].match.eventsSkipped;
        try {
          const events = await apiGet(`/fixtures/events?fixture=${encodeURIComponent(ids[candidate.index])}`, env.APIFOOTBALL_KEY, paceProviderRequests);
          results[candidate.index] = {
            match: analyzeInPlay(candidate.fixture, candidate.stats, events, candidate.observedAt)
          };
        } catch (error) {
          if (error.rateLimited || error.providerAuth) {
            eventLimit = {
              scope: error.limitScope,
              reason: error.rateLimited ? 'rate_limit' : 'provider_auth',
              diagnostic: error.diagnostic
            };
            break;
          }
        }
      }
    }

    if (fatal) {
      return json({
        results: results.filter(Boolean),
        remainingIds: ids.filter((id, index) => !results[index]),
        stopped: fatal.rateLimited
          ? {
            reason: 'rate_limit',
            scope: fatal.limitScope,
            retryAfterSeconds: fatal.retryAfterSeconds,
            diagnostic: fatal.diagnostic
          }
          : { reason: 'provider_auth' }
      });
    }
    return json({ results, remainingIds: [], ...(eventLimit ? { eventLimit } : {}) });
  } catch (error) {
    return errorResponse(error);
  }
}

async function getEligibleFixtures(origin, key, paceProviderRequests) {
  const cacheKey = new Request(new URL('/api/in-play-fixture-snapshot', origin));
  let fixtures;
  try {
    const cached = await caches.default.match(cacheKey);
    if (cached) fixtures = await cached.json();
  } catch { /* Fetch when the optional cache is unavailable. */ }
  if (!Array.isArray(fixtures)) {
    fixtures = await apiGet('/fixtures?live=all', key, paceProviderRequests);
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

async function apiGet(path, key, paceProviderRequests) {
  await paceProviderRequests();
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
      const daily = quotaState(response.headers.get('x-ratelimit-requests-remaining'));
      const minute = quotaState(response.headers.get('x-ratelimit-remaining'));
      const reportedScope = errors.some((value) => /daily|per day|for the day|day limit/i.test(value)) ? 'daily'
        : errors.some((value) => /minute|per.min/i.test(value)) ? 'minute' : 'unknown';
      error.limitScope = daily === 'exhausted' ? 'daily'
        : minute === 'exhausted' ? 'minute' : reportedScope;
      error.diagnostic = {
        endpoint: path.startsWith('/fixtures/statistics') ? 'statistics' : path.startsWith('/fixtures/events') ? 'events' : 'fixtures',
        httpStatus: response.status,
        dailyQuota: daily,
        minuteQuota: minute
      };
      if (error.rateLimited) {
        console.warn('In-play provider limit', JSON.stringify({ scope: error.limitScope, ...error.diagnostic }));
      }
      error.providerAuth = response.status === 401 || response.status === 403
        || errors.some((value) => /invalid.*(?:key|token)|(?:key|token).*invalid|subscription/i.test(value));
      const retryAfter = response.headers.get('Retry-After');
      const seconds = Number(retryAfter);
      const date = Date.parse(retryAfter);
      error.retryAfterSeconds = retryAfter && Number.isFinite(seconds) && seconds > 0
        ? Math.min(300, Math.ceil(seconds))
        : Number.isFinite(date) && date > Date.now()
          ? Math.min(300, Math.ceil((date - Date.now()) / 1000))
          : 60;
      throw error;
    }
    if (!Array.isArray(payload?.response)) throw new Error('Provider returned an invalid response.');
    return payload.response;
  } finally { clearTimeout(timer); }
}

function createProviderPacer() {
  let lastRequestAt = 0;
  return async () => {
    const delay = Math.max(0, lastRequestAt + PROVIDER_REQUEST_INTERVAL_MS - Date.now());
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    lastRequestAt = Date.now();
  };
}

function errorResponse(error) {
  if (error?.rateLimited) return json({
    error: limitMessage(error.limitScope),
    scope: error.limitScope,
    retryAfterSeconds: error.retryAfterSeconds,
    diagnostic: error.diagnostic
  }, 429);
  if (error?.providerAuth) return json({ error: 'Provider credentials or subscription do not allow this request.' }, 502);
  return json({ error: 'Could not load live fixtures from the provider.' }, 502);
}
function quotaState(header) {
  if (header === null || !/^\d+$/.test(header.trim())) return 'unknown';
  return Number(header) === 0 ? 'exhausted' : 'available';
}
function limitMessage(scope) {
  if (scope === 'daily') return 'Provider reported a daily request limit for the configured API key.';
  if (scope === 'minute') return 'Provider reported a per-minute request limit.';
  return 'Provider returned a rate-limit response; its scope was not specified.';
}
function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
  });
}
