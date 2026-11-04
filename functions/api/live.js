const API_BASE = 'https://v3.football.api-sports.io';
const CACHE_SECONDS = 30;
const STATS_CONCURRENCY = 4;

export async function onRequestGet({ request, env }) {
  if (!env.APIFOOTBALL_KEY) {
    return json({ error: 'Live match service is not configured.' }, 503, { 'Cache-Control': 'no-store' });
  }

  const cacheKey = new Request(new URL('/api/live', request.url).toString(), { method: 'GET' });
  try {
    const cached = await caches.default.match(cacheKey);
    if (cached) return cached;
  } catch {
    // Continue with the upstream request if the edge cache is unavailable.
  }

  try {
    const fixtures = await apiGet('/fixtures?live=all', env.APIFOOTBALL_KEY);
    const matches = await mapWithConcurrency(fixtures, STATS_CONCURRENCY, async (fixture) => {
      try {
        const stats = await apiGet(`/fixtures/statistics?fixture=${encodeURIComponent(fixture.fixture.id)}`, env.APIFOOTBALL_KEY);
        return { fixture, stats };
      } catch (error) {
        return { fixture, stats: [], statsError: safeMessage(error) };
      }
    });

    const result = json({ matches }, 200, {
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

async function apiGet(path, key) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'x-apisports-key': key, Accept: 'application/json' }
  });
  const payload = await response.json().catch(() => ({}));
  const errors = payload.errors && typeof payload.errors === 'object' ? Object.values(payload.errors).filter(Boolean) : [];
  if (!response.ok || errors.length) {
    throw new Error(errors.join(' · ') || `API-Football returned HTTP ${response.status}`);
  }
  return Array.isArray(payload.response) ? payload.response : [];
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

function safeMessage(error) {
  // Avoid returning provider headers, credentials, or raw request details to site visitors.
  return error instanceof Error ? error.message.slice(0, 240) : 'The live data request failed.';
}

function json(value, status, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders }
  });
}
