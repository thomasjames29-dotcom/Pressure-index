import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { onRequestGet } from '../functions/api/stats.js';

const date = '2026-10-18';
const fixture = (id, home, away, status = 'FT') => ({
  fixture: { id, status: { short: status } },
  goals: { home, away },
  teams: { home: { id: 1 }, away: { id: 2 } }
});
const goal = (elapsed, detail = 'Normal Goal', team = 1, extra = null) => ({
  type: 'Goal', detail, team: { id: team }, time: { elapsed, extra }
});
const providerResponse = (response, current = 1, total = 1) => Response.json({
  response, results: response.length, paging: { current, total }, errors: []
});
function setupProvider(handler) {
  const entries = new Map();
  globalThis.caches = { default: {
    match: async (key) => entries.get(key.url)?.clone(),
    put: async (key, value) => entries.set(key.url, value.clone()),
    delete: async (key) => entries.delete(key.url)
  } };
  globalThis.fetch = async (url) => handler(new URL(url));
  return entries;
}
async function getStats(refresh = false, timezone = 'Europe/London') {
  return onRequestGet({
    request: new Request(`https://example.test/api/stats?date=${date}&timezone=${encodeURIComponent(timezone)}${refresh ? '&refresh=1' : ''}`),
    env: { APIFOOTBALL_KEY: 'test' }
  });
}

test('finished statuses, duplicate fixtures, goal types and stoppage-time boundaries', async () => {
  const fixtures = [
    fixture(1, 0, 0), fixture(1, 0, 0), fixture(2, 1, 0), fixture(3, 1, 0),
    fixture(4, 1, 0), fixture(5, 1, 0, 'AET'), fixture(6, 1, 0, 'PEN'),
    fixture(7, 0, 1), fixture(8, 1, 0), fixture(9, 0, 0, 'NS')
  ];
  const events = {
    2: [goal(20, 'Penalty')],
    3: [goal(45, 'Normal Goal', 1, 3)],
    4: [goal(46)],
    5: [goal(75)],
    6: [goal(76), goal(120, 'Penalty Shootout')],
    7: [goal(5, 'Own Goal')],
    8: [goal(21), goal(8, 'Missed Penalty'), goal(10, 'Goal Disallowed')]
  };
  setupProvider((url) => url.pathname.endsWith('/events')
    ? providerResponse(events[url.searchParams.get('fixture')])
    : providerResponse(fixtures));
  const response = await getStats();
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.complete, true);
  assert.equal(data.finishedGames, 8);
  assert.equal(data.classifiedGames, 8);
  assert.deepEqual(data.counts, { noGoals: 1, min0To20: 2, min21ToHalftime: 2, min45To75: 2, min76ToFinish: 1 });
  assert.equal(data.scope, 'local-calendar-kickoff-day');
});

test('missing scores, missing or inconsistent events and provider failures stay unclassified', async () => {
  const fixtures = [...Array.from({ length: 20 }, (_, i) => fixture(i + 1, 0, 0)),
    fixture(30, null, 0), fixture(31, 1, 0), fixture(32, 2, 0), fixture(33, 1, 0)];
  setupProvider((url) => {
    if (!url.pathname.endsWith('/events')) return providerResponse(fixtures);
    const id = url.searchParams.get('fixture');
    if (id === '31') return providerResponse([]);
    if (id === '32') return providerResponse([goal(10)]);
    throw new DOMException('Timed out', 'AbortError');
  });
  const data = await (await getStats()).json();
  assert.equal(data.finishedGames, 24);
  assert.equal(data.counts.noGoals, 20);
  assert.equal(data.classifiedGames, 20);
  assert.equal(data.unclassifiedGames, 4);
  assert.equal(data.complete, false);
  assert.equal(data.diagnostics.scoreUnavailable, 1);
  assert.equal(data.diagnostics.eventsMissing, 1);
  assert.equal(data.diagnostics.eventsInconsistent, 1);
  assert.equal(data.diagnostics.eventFailures, 1);
});

test('rate limit stops further requests without counting games as goalless', async () => {
  let eventCalls = 0;
  setupProvider((url) => {
    if (!url.pathname.endsWith('/events')) return providerResponse(Array.from({ length: 12 }, (_, i) => fixture(i, 1, 0)));
    eventCalls += 1;
    return Response.json({ errors: { rateLimit: 'Too many requests' } }, { status: 429 });
  });
  const data = await (await getStats()).json();
  assert.equal(eventCalls, 1);
  assert.equal(data.diagnostics.eventRateLimited, 1);
  assert.equal(data.diagnostics.eventLimit, 11);
  assert.equal(data.unclassifiedGames, 12);
  assert.equal(data.counts.noGoals, 0);
});

test('event request budget bounds busy days and reports the skipped games', async () => {
  let eventCalls = 0;
  setupProvider((url) => {
    if (!url.pathname.endsWith('/events')) return providerResponse(Array.from({ length: 42 }, (_, i) => fixture(i + 1, 1, 0)));
    eventCalls += 1;
    return providerResponse([goal(10)]);
  });
  const data = await (await getStats()).json();
  assert.equal(eventCalls, 40);
  assert.equal(data.classifiedGames, 40);
  assert.equal(data.diagnostics.eventLimit, 2);
  assert.equal(data.unclassifiedGames, 2);
  assert.equal(data.complete, false);
});

test('pagination, provider errors, and malformed payloads cannot masquerade as zero games', async () => {
  let mode = 'partial';
  setupProvider((url) => {
    if (mode === 'error') return Response.json({ errors: { requests: 'Quota exhausted' } });
    if (mode === 'malformed') return Response.json({ response: [] });
    if (url.searchParams.get('page') === '2') return new Response('unavailable', { status: 503 });
    return providerResponse([fixture(1, 0, 0)], 1, 2);
  });
  let response = await getStats();
  let data = await response.json();
  assert.equal(data.complete, false);
  assert.equal(data.finishedGames, 1);
  assert.equal(data.diagnostics.fixturePagesMissing, 1);
  assert.equal(data.diagnostics.fixturePageFailures, 1);
  mode = 'error';
  response = await getStats();
  assert.equal(response.status, 502);
  mode = 'malformed';
  response = await getStats();
  assert.equal(response.status, 502);
  mode = 'empty';
  setupProvider(() => providerResponse([]));
  data = await (await getStats()).json();
  assert.equal(data.finishedGames, 0);
  assert.equal(data.complete, true);
});

test('refresh invalidates old edge data even if refresh is incomplete', async () => {
  let fixtures = [fixture(1, 0, 0)];
  let calls = 0;
  const entries = setupProvider((url) => {
    calls += 1;
    return url.pathname.endsWith('/events') ? providerResponse([]) : providerResponse(fixtures);
  });
  assert.equal((await (await getStats()).json()).counts.noGoals, 1);
  await getStats();
  assert.equal(calls, 1);
  fixtures = [fixture(2, 1, 0)];
  assert.equal((await (await getStats(true)).json()).complete, false);
  assert.equal(entries.size, 0);
  fixtures = [fixture(3, 0, 0), fixture(4, 0, 0)];
  assert.equal((await (await getStats()).json()).counts.noGoals, 2);
  assert.equal((await getStats()).headers.get('cache-control'), 'no-store');
});

test('fixture pages are deduplicated and team score mismatches remain unclassified', async () => {
  setupProvider((url) => {
    if (url.pathname.endsWith('/events')) return providerResponse([goal(30, 'Normal Goal', 2)]);
    if (url.searchParams.get('page') === '2') return providerResponse([fixture(1, 0, 0), fixture(2, 1, 0)], 2, 2);
    return providerResponse([fixture(1, 0, 0)], 1, 2);
  });
  const data = await (await getStats()).json();
  assert.equal(data.finishedGames, 2);
  assert.equal(data.counts.noGoals, 1);
  assert.equal(data.diagnostics.eventsInconsistent, 1);
});

test('stats requests use the local calendar date, unlike the dashboard 8am window', async () => {
  let query;
  setupProvider((url) => { query = url.searchParams; return providerResponse([]); });
  const data = await (await getStats(false, 'America/New_York')).json();
  assert.equal(query.get('date'), date);
  assert.equal(query.get('timezone'), 'America/New_York');
  assert.equal(data.scope, 'local-calendar-kickoff-day');
  const source = await readFile(new URL('../functions/api/fixtures.js', import.meta.url), 'utf8');
  const context = { Intl, Date };
  vm.createContext(context);
  vm.runInContext(source.replace('export async function', 'async function'), context);
  const window = vm.runInContext("getLocalWindowForDay(new Date('2026-10-18T16:00:00Z'), 'America/New_York', 0)", context);
  assert.equal(new Date(window.startMs).toISOString(), '2026-10-18T12:00:00.000Z');
  assert.equal(new Date(window.endMs).toISOString(), '2026-10-19T12:00:00.000Z');
});

test('service worker bypasses API requests', async () => {
  const source = await readFile(new URL('../service-worker.js', import.meta.url), 'utf8');
  const handlers = {};
  const context = { URL, self: { addEventListener: (type, handler) => { handlers[type] = handler; } } };
  vm.runInNewContext(source, context);
  let intercepted = false;
  handlers.fetch({ request: { method: 'GET', url: 'https://example.test/api/stats?refresh=1' }, respondWith: () => { intercepted = true; } });
  assert.equal(intercepted, false);
});

async function browser() {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  const elements = new Map();
  const storage = new Map();
  const context = {
    document: {
      querySelector: (selector) => {
        if (!elements.has(selector)) elements.set(selector, { value: '', textContent: '', disabled: false });
        return elements.get(selector);
      },
      querySelectorAll: () => []
    },
    localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value)
    },
    window: { confirm: () => true },
    Intl, Date, console
  };
  vm.createContext(context);
  vm.runInContext(source.slice(0, source.indexOf('\nviewButtons.forEach((button) => button.addEventListener')), context);
  elements.get('#statsDaySelect').value = date;
  return { context, elements, storage, run: (code) => vm.runInContext(code, context) };
}
function payload(counts, overrides = {}) {
  const classifiedGames = Object.values(counts).reduce((a, b) => a + b, 0);
  return { version: 2, date, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/London', counts,
    finishedGames: classifiedGames, classifiedGames, unclassifiedGames: 0, complete: true,
    diagnostics: { fixturePagesMissing: 0 }, updatedAt: new Date().toISOString(), ...overrides };
}
const zeros = { noGoals: 0, min0To20: 0, min21ToHalftime: 0, min45To75: 0, min76ToFinish: 0 };

test('legacy and manual counts remain unverified and cannot be silently replaced', async () => {
  const b = await browser();
  b.storage.set('pressure-index-first-goal-stats', JSON.stringify({ [date]: { ...zeros, noGoals: 9 } }));
  b.run(`populateStatsInputs('${date}')`);
  assert.match(b.elements.get('#statsDataStatus').textContent, /unverified/i);
  let calls = 0;
  b.context.fetch = async () => { calls += 1; return Response.json(payload({ ...zeros, noGoals: 1 })); };
  await b.run(`loadStatsForDate('${date}')`);
  assert.equal(calls, 0);
  const incomplete = payload({ ...zeros, noGoals: 1 }, { finishedGames: 2, unclassifiedGames: 1, complete: false });
  b.context.fetch = async () => Response.json(incomplete);
  await b.run(`loadStatsForDate('${date}', true)`);
  assert.match(b.elements.get('#statsDataStatus').textContent, /INCOMPLETE refresh/);
  assert.equal(JSON.parse(b.storage.get('pressure-index-first-goal-stats'))[date].noGoals, 9);
  b.context.fetch = async (url, options) => {
    assert.match(url, /refresh=1/);
    assert.equal(options.cache, 'no-store');
    return Response.json(payload({ ...zeros, noGoals: 2 }));
  };
  await b.run(`loadStatsForDate('${date}', true)`);
  assert.equal(JSON.parse(b.storage.get('pressure-index-first-goal-stats'))[date].noGoals, 2);
  b.run('saveSelectedDayStats()');
  assert.equal(JSON.parse(b.storage.get('pressure-index-first-goal-stats-meta'))[date].source, 'manual');
});

test('partial refresh keeps complete saved data and rolling totals exclude incomplete and stale days', async () => {
  const b = await browser();
  const recent = b.run("addDays(getLocalDateKey(), -1)");
  const stale = b.run("addDays(getLocalDateKey(), -2)");
  const today = b.run('getLocalDateKey()');
  const tz = b.run('timezone');
  b.storage.set('pressure-index-first-goal-stats', JSON.stringify({ [recent]: { ...zeros, noGoals: 4 }, [stale]: { ...zeros, noGoals: 8 }, [today]: { ...zeros, noGoals: 3 } }));
  b.storage.set('pressure-index-first-goal-stats-meta', JSON.stringify({
    [recent]: { version: 2, source: 'provider', timezone: tz, complete: true },
    [today]: { version: 2, source: 'provider', timezone: tz, complete: true }
  }));
  const result = b.run('recentStats(7)');
  assert.equal(result.completeDays, 1);
  assert.equal(result.incompleteDays, 2);
  assert.equal(result.missingDays, 4);
  assert.equal(result.totals.noGoals, 4);
  b.elements.get('#statsDaySelect').value = recent;
  b.context.fetch = async () => Response.json(payload({ ...zeros, noGoals: 1 }, { date: recent, finishedGames: 2, unclassifiedGames: 1, complete: false }));
  await b.run(`loadStatsForDate('${recent}', true)`);
  assert.equal(JSON.parse(b.storage.get('pressure-index-first-goal-stats'))[recent].noGoals, 4);
  assert.match(b.elements.get('#statsDataStatus').textContent, /kept/);
  const metadata = JSON.parse(b.storage.get('pressure-index-first-goal-stats-meta'));
  metadata[recent].complete = false;
  b.storage.set('pressure-index-first-goal-stats-meta', JSON.stringify(metadata));
  await b.run(`loadStatsForDate('${recent}', true)`);
  assert.equal(JSON.parse(b.storage.get('pressure-index-first-goal-stats'))[recent].noGoals, 4);
});
