import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet, onRequestPost } from '../functions/api/in-play.js';

function fixture(id, status = '1H', elapsed = 30) {
  return {
    fixture: { id, status: { short: status, elapsed } },
    teams: { home: { name: 'Home' }, away: { name: 'Away' } },
    goals: { home: 0, away: 0 },
    league: { name: 'League' }
  };
}
const request = (method, body) => new Request('https://example.test/api/in-play', {
  method,
  ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
});

test('fixture discovery filters status, minute, and duplicate matches', async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  globalThis.caches = { default: { async match() {}, async put() {} } };
  globalThis.fetch = async () => new Response(JSON.stringify({
    response: [fixture(2), fixture(1, 'HT', 45), fixture(2), fixture(3, '2H', 81), fixture(4, '2H', 60)]
  }));
  try {
    const response = await onRequestGet({ request: request('GET'), env: { APIFOOTBALL_KEY: 'test-key' } });
    assert.deepEqual((await response.json()).fixtures, [{ id: '2', priority: false }, { id: '4', priority: false }]);
  } finally { globalThis.fetch = originalFetch; globalThis.caches = originalCaches; }
});

test('batch caps inputs, rejects non-live IDs and limits provider concurrency', async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const fixtures = Array.from({ length: 8 }, (_, index) => fixture(index + 1));
  globalThis.caches = { default: { async match() { return new Response(JSON.stringify(fixtures)); } } };
  let running = 0;
  let maxRunning = 0;
  globalThis.fetch = async (url) => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((resolve) => setTimeout(resolve, 2));
    running -= 1;
    const response = String(url).includes('/statistics')
      ? [{ statistics: [{ type: 'Total Shots', value: 4 }] }, { statistics: [{ type: 'Total Shots', value: 5 }] }]
      : [];
    return new Response(JSON.stringify({ response }));
  };
  try {
    const env = { APIFOOTBALL_KEY: 'test-key' };
    const oversized = await onRequestPost({ request: request('POST', { ids: Array.from({ length: 9 }, (_, i) => String(i + 1)) }), env });
    assert.equal(oversized.status, 400);
    const response = await onRequestPost({ request: request('POST', { ids: ['1', '2', '3', '4', '5', '6', '7', '999'] }), env });
    const { results } = await response.json();
    assert.equal(results.filter((item) => item.match).length, 7);
    assert.equal(results[7].error, 'Match is no longer eligible or live.');
    assert.ok(maxRunning <= 2);
  } finally { globalThis.fetch = originalFetch; globalThis.caches = originalCaches; }
});

test('provider quota failure is surfaced and preserves unprocessed matches', async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  globalThis.caches = { default: { async match() { return new Response(JSON.stringify([fixture(1)])); } } };
  globalThis.fetch = async () => new Response(JSON.stringify({ errors: { requests: 'Daily quota exceeded' } }), { status: 429 });
  try {
    const response = await onRequestPost({ request: request('POST', { ids: ['1'] }), env: { APIFOOTBALL_KEY: 'test-key' } });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.stopped.reason, 'rate_limit');
    assert.equal(result.stopped.scope, 'daily');
    assert.deepEqual(result.remainingIds, ['1']);
  } finally { globalThis.fetch = originalFetch; globalThis.caches = originalCaches; }
});

test('provider calls are spaced and a failed events request preserves the match', async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  globalThis.caches = { default: { async match() { return new Response(JSON.stringify([fixture(1)])); } } };
  const requestTimes = [];
  globalThis.fetch = async (url) => {
    requestTimes.push(Date.now());
    return String(url).includes('/events')
      ? new Response('{}', { status: 500 })
      : new Response(JSON.stringify({
      response: [{ statistics: [{ type: 'Total Shots', value: 3 }] }, { statistics: [{ type: 'Total Shots', value: 2 }] }]
      }));
  };
  try {
    const response = await onRequestPost({ request: request('POST', { ids: ['1'] }), env: { APIFOOTBALL_KEY: 'test-key' } });
    const result = (await response.json()).results[0];
    assert.equal(result.match.eventsAvailable, false);
    assert.equal(requestTimes.length, 2);
    assert.ok(requestTimes[1] - requestTimes[0] >= 200);
  } finally { globalThis.fetch = originalFetch; globalThis.caches = originalCaches; }
});

test('rate limit during events keeps statistics and reports retry delay', async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  globalThis.caches = { default: { async match() { return new Response(JSON.stringify([fixture(1), fixture(2)])); } } };
  globalThis.fetch = async (url) => String(url).includes('/events')
    ? new Response(JSON.stringify({ errors: { rateLimit: 'Per minute request limit reached' } }), { status: 429, headers: { 'Retry-After': '7' } })
    : new Response(JSON.stringify({
      response: [{ statistics: [{ type: 'Total Shots', value: 3 }] }, { statistics: [{ type: 'Total Shots', value: 2 }] }]
    }));
  try {
    const response = await onRequestPost({ request: request('POST', { ids: ['1', '2'] }), env: { APIFOOTBALL_KEY: 'test-key' } });
    const result = await response.json();
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].match.id, '1');
    assert.equal(result.results[0].match.eventsAvailable, false);
    assert.deepEqual(result.remainingIds, ['2']);
    assert.equal(result.stopped.scope, 'minute');
    assert.equal(result.stopped.retryAfterSeconds, 7);
  } finally { globalThis.fetch = originalFetch; globalThis.caches = originalCaches; }
});

test('diagnostic distinguishes minute and daily headroom without exposing values or keys', async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  globalThis.caches = { default: { async match() { return new Response(JSON.stringify([fixture(1)])); } } };
  globalThis.fetch = async () => new Response(JSON.stringify({
    errors: { rateLimit: 'Too many requests' }
  }), {
    status: 200,
    headers: { 'x-ratelimit-requests-remaining': '43210', 'x-ratelimit-remaining': '0' }
  });
  try {
    const response = await onRequestPost({ request: request('POST', { ids: ['1'] }), env: { APIFOOTBALL_KEY: 'test-secret-key' } });
    const data = await response.json();
    assert.equal(data.stopped.scope, 'minute');
    assert.deepEqual(data.stopped.diagnostic, {
      endpoint: 'statistics', httpStatus: 200, dailyQuota: 'available', minuteQuota: 'exhausted'
    });
    assert.ok(!JSON.stringify(data).includes('43210'));
    assert.ok(!JSON.stringify(data).includes('test-secret-key'));
  } finally { globalThis.fetch = originalFetch; globalThis.caches = originalCaches; }
});
