import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet } from '../functions/api/calibration.js';

test('calibration endpoint validates input and protects the provider key', async () => {
  const missingKey = await onRequestGet({
    request: new Request('https://example.test/api/calibration?league=39&season=2025'),
    env: {}
  });
  assert.equal(missingKey.status, 503);
  const invalid = await onRequestGet({
    request: new Request('https://example.test/api/calibration?league=bad&season=2025'),
    env: { APIFOOTBALL_KEY: 'secret-key' }
  });
  assert.equal(invalid.status, 400);
});

test('successful replay returns a validated factor and reuses the edge cache', async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const cached = new Map();
  let fetchCount = 0;
  globalThis.caches = {
    default: {
      async match(key) { return cached.get(key.url)?.clone(); },
      async put(key, value) { cached.set(key.url, value.clone()); }
    }
  };
  globalThis.fetch = async () => {
    fetchCount += 1;
    const fixtures = Array.from({ length: 200 }, (_, index) => ({
      fixture: { id: index + 1, date: new Date(Date.UTC(2025, 0, index + 1)).toISOString(), status: { short: 'FT' } },
      league: { name: 'Test League' },
      teams: { home: { id: 1, name: 'Home' }, away: { id: 2, name: 'Away' } },
      goals: { home: 1, away: 0 }
    }));
    return new Response(JSON.stringify({ response: fixtures }));
  };

  try {
    const context = {
      request: new Request('https://example.test/api/calibration?league=39&season=2025'),
      env: { APIFOOTBALL_KEY: 'secret-key' }
    };
    const response = await onRequestGet(context);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.eligible, true);
    assert.ok(payload.intercept > 0);
    assert.ok(payload.calibrated.brierScore < payload.raw.brierScore);
    assert.ok(payload.calibrated.logLoss < payload.raw.logLoss);
    assert.ok(!JSON.stringify(payload).includes('secret-key'));
    assert.equal((await onRequestGet(context)).status, 200);
    assert.equal(fetchCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  }
});

test('a factor that worsens held-out scores is not returned for application', async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  globalThis.caches = { default: { async match() {}, async put() {} } };
  globalThis.fetch = async () => new Response(JSON.stringify({
    response: Array.from({ length: 200 }, (_, index) => ({
      fixture: { id: index + 1, date: new Date(Date.UTC(2025, 0, index + 1)).toISOString(), status: { short: 'FT' } },
      league: { name: 'Test League' },
      teams: { home: { id: 1, name: 'Home' }, away: { id: 2, name: 'Away' } },
      goals: { home: index < 140 ? 1 : 0, away: 0 }
    }))
  }));
  try {
    const response = await onRequestGet({
      request: new Request('https://example.test/api/calibration?league=39&season=2025'),
      env: { APIFOOTBALL_KEY: 'test-key' }
    });
    const payload = await response.json();
    assert.equal(payload.trainingCount, 140);
    assert.equal(payload.holdoutCount, 60);
    assert.equal(payload.eligible, false);
    assert.equal(payload.intercept, null);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  }
});
