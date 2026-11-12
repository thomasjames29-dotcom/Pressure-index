import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeInPlay, rankInPlay, isPriorityLeague, selectInPlayFixtures } from '../lib/inplay-model.mjs';

const fixture = {
  fixture: { id: 1, status: { short: '1H', elapsed: 30 } },
  teams: { home: { name: 'Home' }, away: { name: 'Away' } },
  goals: { home: 0, away: 0 },
  league: { name: 'League' }
};
const team = (shots, onTarget, corners, xg) => ({
  statistics: [
    { type: 'Total Shots', value: shots },
    { type: 'Shots on Goal', value: onTarget },
    { type: 'Corner Kicks', value: corners },
    { type: 'expected_goals', value: xg }
  ]
});

test('pressure rises with attacking activity and does not treat missing stats as zero', () => {
  const quiet = analyzeInPlay(fixture, [team(1, 0, null), team(1, 0, null)], [], '2026-01-01T10:00:00Z');
  const active = analyzeInPlay(fixture, [team(5, 2, null), team(5, 2, null)], [], '2026-01-01T10:00:00Z');
  assert.ok(active.pressure > quiet.pressure);
  assert.equal(active.totals.corners, null);
  assert.equal(analyzeInPlay(fixture, [team(null, null, 2), team(3, 1, 2)], [], ''), null);
});

test('event context ignores cancelled goals and reports missing events', () => {
  const stats = [team(2, 1, 1), team(2, 1, 1)];
  const cancelled = analyzeInPlay(fixture, stats, [{ type: 'Goal', detail: 'Goal cancelled', time: { elapsed: 28 } }], '');
  assert.equal(cancelled.recentGoal, false);
  const missing = analyzeInPlay(fixture, stats, null, '');
  assert.equal(missing.eventsAvailable, false);
  const red = analyzeInPlay(fixture, stats, [{ type: 'Card', detail: 'Red Card', time: { elapsed: 29 } }], '');
  assert.equal(red.recentRed, true);
});

test('momentum uses only comparable earlier samples and rejects resets and stale samples', () => {
  const first = analyzeInPlay(fixture, [team(2, 1, 1), team(2, 1, 1)], [], '2026-01-01T10:00:00Z');
  const nextFixture = { ...fixture, fixture: { ...fixture.fixture, status: { short: '1H', elapsed: 35 } } };
  const next = analyzeInPlay(nextFixture, [team(4, 2, 2), team(3, 1, 1)], [], '2026-01-01T10:05:00Z');
  assert.ok(rankInPlay(next, first).momentum > 0);
  assert.equal(rankInPlay({ ...next, status: '2H' }, first).momentum, null);
  assert.equal(rankInPlay({ ...next, observedAt: '2026-01-01T11:00:00Z' }, first).momentum, null);
  assert.equal(rankInPlay(first, next).momentum, null);
});

test('busy sweeps prioritize major leagues, reserve other places and rotate', () => {
  assert.equal(isPriorityLeague(39), true);
  assert.equal(isPriorityLeague(9999), false);
  const fixtures = [
    ...Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, priority: true })),
    ...Array.from({ length: 20 }, (_, i) => ({ id: `o${i}`, priority: false }))
  ];
  const first = selectInPlayFixtures(fixtures);
  assert.equal(first.ids.length, 32);
  assert.equal(first.ids.filter((id) => id.startsWith('p')).length, 24);
  assert.equal(first.ids.filter((id) => id.startsWith('o')).length, 8);
  const next = selectInPlayFixtures(fixtures, first.cursors);
  assert.equal(next.ids[0], 'p24');
  assert.ok(next.ids.includes('o8'));
  assert.equal(selectInPlayFixtures(fixtures.slice(0, 40)).ids.length, 32);
});
