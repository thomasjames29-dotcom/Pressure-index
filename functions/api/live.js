const API_BASE = 'https://v3.football.api-sports.io';
const CACHE_SECONDS = 30;
const STATS_CONCURRENCY = 2;
const MAX_STATS_BATCH = 8;
const MAX_RETRIES = 4;
const REQUEST_TIMEOUT_MS = 12_000;
const BASE_BACKOFF_MS = 500;

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
    const matches = [];
    const batches = chunkArray(fixtures, MAX_STATS_BATCH);

    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index];
      const batchMatches = await mapWithConcurrency(batch, STATS_CONCURRENCY, async (fixture) => {
        const [statsResult, eventsResult] = await Promise.allSettled([
          apiGet(`/fixtures/statistics?fixture=${encodeURIComponent(fixture.fixture.id)}`, env.APIFOOTBALL_KEY),
          apiGet(`/fixtures/events?fixture=${encodeURIComponent(fixture.fixture.id)}`, env.APIFOOTBALL_KEY)
        ]);
        return {
          fixture,
          stats: statsResult.status === 'fulfilled' ? statsResult.value : [],
          statsError: statsResult.status === 'rejected' ? safeMessage(statsResult.reason) : undefined,
          events: eventsResult.status === 'fulfilled' ? eventsResult.value : [],
          eventsError: eventsResult.status === 'rejected' ? safeMessage(eventsResult.reason) : undefined
        };
      });
      matches.push(...batchMatches);

      if (index < batches.length - 1) {
        await sleep(350);
      }
    }

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
      const isRateLimited = response.status === 429 || hasRateLimitError(errors);
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

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
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

function hasRateLimitError(errors) {
  return errors.some((message) => typeof message === 'string' && /rate limit|too many requests|quota/i.test(message));
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
