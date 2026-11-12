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
function detail(id) {
  return {
    ...fixture(id),
    statistics: [{ statistics: [{ type: 'Total Shots', value: 3 }] }, { statistics: [{ type: 'Total Shots', value: 2 }] }],
    events: [{ type: 'Goal', detail: 'Normal Goal', time: { elapsed: 25 } }]
  };
}
const request = (method, body) => new Request('https://example.test/api/in-play', {
  method,
  ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
});
const env = { APIFOOTBALL_KEY: 'test-secret-key' };

test('fixture discovery filters status, minute, and duplicate matches', async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  globalThis.caches = { default: { async match() {}, async put() {} } };
  globalThis.fetch = async () => new Response(JSON.stringify({
    response: [fixture(2), fixture(1, 'HT', 45), fixture(2), fixture(3, '2H', 81), fixture(4, '2H', 60)]
  }));
  try {
    const response = await onRequestGet({ request: request('GET'), env });
    assert.deepEqual((await response.json()).fixtures, [{ id: '2', priority: false }, { id: '4', priority: false }]);
  } finally { globalThis.fetch = originalFetch; globalThis.caches = originalCaches; }
});

test('bulk fixture details return statistics and events in one provider call and preserve input order', async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  globalThis.caches = { default: { async match() { return new Response(JSON.stringify([fixture(1), fixture(2), fixture(3)])); } } };
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ response: [detail(2), detail(1)] }));
  };
  try {
    const response = await onRequestPost({ request: request('POST', { ids: ['1', '2', '3', '999'] }), env });
    const result = await response.json();
    assert.deepEqual(calls, ['https://v3.football.api-sports.io/fixtures?ids=1-2-3']);
    assert.deepEqual(result.results.map((item) => item.match?.id ?? item.id), ['1', '2', '3', '999']);
    assert.equal(result.results[0].match.totals.shots, 5);
    assert.equal(result.results[0].match.recentGoal, true);
    assert.equal(result.results[0].match.eventsAvailable, true);
    assert.equal(result.results[2].error, 'Live fixture details unavailable.');
    assert.equal(result.results[3].error, 'Match is no longer eligible or live.');
    assert.deepEqual(result.remainingIds, []);
  } finally { globalThis.fetch = originalFetch; globalThis.caches = originalCaches; }
});

test('accepts 20 distinct IDs and rejects larger or duplicate batches', async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const fixtures = Array.from({ length: 20 }, (_, i) => fixture(i + 1));
  globalThis.caches = { default: { async match() { return new Response(JSON.stringify(fixtures)); } } };
  globalThis.fetch = async () => new Response(JSON.stringify({ response: fixtures.map((item) => detail(item.fixture.id)) }));
  try {
    const ids = fixtures.map((item) => String(item.fixture.id));
    assert.equal((await onRequestPost({ request: request('POST', { ids }), env })).status, 200);
    assert.equal((await onRequestPost({ request: request('POST', { ids: [...ids, '21'] }), env })).status, 400);
    assert.equal((await onRequestPost({ request: request('POST', { ids: ['1', '1'] }), env })).status, 400);
  } finally { globalThis.fetch = originalFetch; globalThis.caches = originalCaches; }
});

test('ineligible or incomplete detailed data is not ranked and missing events are explicit', async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  globalThis.caches = { default: { async match() { return new Response(JSON.stringify([fixture(1), fixture(2), fixture(3)])); } } };
  globalThis.fetch = async () => new Response(JSON.stringify({ response: [
    { ...detail(1), fixture: fixture(1, 'HT', 45).fixture },
    { ...detail(2), statistics: [] },
    { ...detail(3), events: undefined }
  ] }));
  try {
    const response = await onRequestPost({ request: request('POST', { ids: ['1', '2', '3'] }), env });
    const result = await response.json();
    assert.equal(result.results[0].error, 'Match is no longer eligible or live.');
    assert.equal(result.results[1].error, 'Insufficient shot statistics for both teams.');
    assert.equal(result.results[2].match.eventsAvailable, false);
  } finally { globalThis.fetch = originalFetch; globalThis.caches = originalCaches; }
});

test('bulk provider limit reports unprocessed IDs and safe diagnostics', async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  globalThis.caches = { default: { async match() { return new Response(JSON.stringify([fixture(1)])); } } };
  globalThis.fetch = async () => new Response(JSON.stringify({ errors: { rateLimit: 'Per minute request limit reached' } }), {
    status: 200, headers: { 'Retry-After': '7', 'x-ratelimit-requests-remaining': '43210', 'x-ratelimit-remaining': '0' }
  });
  try {
    const response = await onRequestPost({ request: request('POST', { ids: ['1', '999'] }), env });
    const result = await response.json();
    assert.deepEqual(result.remainingIds, ['1']);
    assert.equal(result.results[0].id, '999');
    assert.equal(result.stopped.scope, 'minute');
    assert.equal(result.stopped.retryAfterSeconds, 7);
    assert.deepEqual(result.stopped.diagnostic, {
      endpoint: 'details', httpStatus: 200, dailyQuota: 'available', minuteQuota: 'exhausted'
    });
    assert.ok(!JSON.stringify(result).includes('43210'));
    assert.ok(!JSON.stringify(result).includes(env.APIFOOTBALL_KEY));
  } finally { globalThis.fetch = originalFetch; globalThis.caches = originalCaches; }
});
