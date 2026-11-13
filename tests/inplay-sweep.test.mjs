import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const sweepCode = app.slice(app.indexOf('async function sweepInPlay()'), app.indexOf('function escapeHtml(value)'));

function harness(responses) {
  const calls = [];
  const delays = [];
  let now = 10_000;
  const context = createContext({
    sweepInplayButton: { disabled: false },
    inplayResults: { innerHTML: '' },
    inplayStatus: { textContent: '' },
    previousInplay: new Map(),
    inplayCursors: {},
    selectInPlayFixtures: (fixtures) => ({ ids: fixtures, cursors: {} }),
    rankInPlay: (match) => match,
    renderInPlay: (matches) => { context.rendered = Array.from(matches); },
    Date: { now: () => now },
    setTimeout: (callback, delay) => { delays.push(delay); now += delay; callback(); },
    fetch: async (url, options) => {
      calls.push({ url, options });
      assert.ok(responses.length, 'Unexpected automatic request');
      const { status = 200, payload } = responses.shift();
      return { status, ok: status >= 200 && status < 300, json: async () => payload };
    }
  });
  runInContext(sweepCode, context);
  return { context, calls, delays, run: () => runInContext('sweepInPlay()', context) };
}

const limit = { scope: 'minute', retryAfterSeconds: 60 };
const matches = (ids) => ids.map((id) => ({ match: { id } }));

test('fixture-list limit stops immediately and permits manual refresh', async () => {
  const h = harness([{ status: 429, payload: limit }, { payload: { fixtures: [] } }]);
  await h.run();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.delays, []);
  assert.equal(h.context.sweepInplayButton.disabled, false);
  assert.match(h.context.inplayStatus.textContent, /Press Refresh live sweep to try again/);
  await h.run();
  assert.equal(h.calls.length, 2);
  assert.match(h.context.inplayStatus.textContent, /No eligible matches/);
});

test('batch HTTP limit retains completed matches without retrying', async () => {
  const ids = Array.from({ length: 21 }, (_, i) => i + 1);
  const h = harness([
    { payload: { fixtures: ids } },
    { payload: { results: matches(ids.slice(0, 20)), remainingIds: [] } },
    { status: 429, payload: limit }
  ]);
  await h.run();
  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.delays, [1000]);
  assert.equal(h.context.rendered.length, 20);
  assert.equal(h.context.sweepInplayButton.disabled, false);
  assert.match(h.context.inplayStatus.textContent, /Screened 20 of 21/);
  assert.match(h.context.inplayStatus.textContent, /Press Refresh live sweep to try again/);
});

test('batch payload limit retains partial results and stops immediately', async () => {
  const h = harness([
    { payload: { fixtures: [1, 2] } },
    { payload: { results: matches([1]), remainingIds: [2], stopped: { reason: 'rate_limit', ...limit } } }
  ]);
  await h.run();
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.delays, []);
  assert.equal(h.context.rendered.length, 1);
  assert.equal(h.context.sweepInplayButton.disabled, false);
  assert.match(h.context.inplayStatus.textContent, /Screened 1 of 2/);
  assert.match(h.context.inplayStatus.textContent, /Press Refresh live sweep to try again/);
});

test('successful batches retain one-second pacing', async () => {
  const ids = Array.from({ length: 21 }, (_, i) => i + 1);
  const h = harness([
    { payload: { fixtures: ids } },
    { payload: { results: matches(ids.slice(0, 20)), remainingIds: [] } },
    { payload: { results: matches(ids.slice(20)), remainingIds: [] } }
  ]);
  await h.run();
  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.delays, [1000]);
  assert.equal(h.context.rendered.length, 21);
  assert.equal(h.context.sweepInplayButton.disabled, false);
  assert.match(h.context.inplayStatus.textContent, /Screened 21 of 21/);
});
