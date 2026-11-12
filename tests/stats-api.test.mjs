import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet } from '../functions/api/stats.js';

test('finished match stats fetch goal events in batches and count missing event data', async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  globalThis.caches = { default: { async match() {}, async put() {} } };
  const fixtures = Array.from({ length: 22 }, (_, i) => ({
    fixture: { id: i + 1, status: { short: 'FT' } }, goals: { home: 1, away: 0 }
  }));
  fixtures.push({ fixture: { id: 23, status: { short: 'FT' } }, goals: { home: 0, away: 0 } });
  const paths = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    paths.push(parsed.pathname + parsed.search);
    const ids = parsed.searchParams.get('ids');
    const response = ids
      ? ids.split('-').map((id) => ({
        fixture: { id: Number(id) },
        ...(id === '22' ? {} : { events: [{ type: 'Goal', detail: 'Normal Goal', time: { elapsed: 10 } }] })
      }))
      : fixtures;
    return new Response(JSON.stringify({ response }));
  };
  try {
    const response = await onRequestGet({
      request: new Request('https://example.test/api/stats?date=2026-11-11&timezone=Europe%2FLondon'),
      env: { APIFOOTBALL_KEY: 'test-key' }
    });

    const result = await response.json();
    assert.equal(result.finishedGames, 23);
    assert.equal(result.classifiedGames, 22);
    assert.equal(result.unclassifiedGames, 1);
    assert.equal(result.counts.noGoals, 1);
    assert.equal(result.counts.min0To20, 21);
    assert.equal(paths.length, 3);
    assert.equal(new URL(`https://example.test${paths[1]}`).searchParams.get('ids').split('-').length, 20);
    assert.equal(new URL(`https://example.test${paths[2]}`).searchParams.get('ids'), '21-22');
  } finally { globalThis.fetch = originalFetch; globalThis.caches = originalCaches; }
});

test('a provider batch failure is surfaced rather than saving incomplete totals', async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  globalThis.caches = { default: { async match() {}, async put() { throw new Error('must not cache failure'); } } };
  globalThis.fetch = async (url) => new URL(url).searchParams.has('ids')
    ? new Response(JSON.stringify({ errors: { requests: 'Per minute request limit reached' } }))
    : new Response(JSON.stringify({ response: [
      { fixture: { id: 1, status: { short: 'FT' } }, goals: { home: 1, away: 0 } }
    ] }));
  try {
    const response = await onRequestGet({
      request: new Request('https://example.test/api/stats?date=2026-11-11'),
      env: { APIFOOTBALL_KEY: 'test-key' }
    });
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /request limit/);
  } finally { globalThis.fetch = originalFetch; globalThis.caches = originalCaches; }
});
