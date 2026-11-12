import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLeagueTable, estimateMatchGoals } from '../functions/api/fixtures.js';
import {
  buildCalibrationReport,
  replayLeagueSeason
} from '../scripts/calibrate-fixtures.mjs';

test('historical replay uses pre-kickoff data and treats simultaneous matches as a batch', async () => {
  const originalFetch = globalThis.fetch;
  const fixtures = [
    match(1, '2025-08-01T12:00:00Z', 1, 2, 1, 0),
    match(2, '2025-08-08T12:00:00Z', 1, 3, 0, 0),
    match(3, '2025-08-15T12:00:00Z', 2, 3, 2, 1),
    match(4, '2025-08-22T12:00:00Z', 1, 2, 1, 1),
    match(5, '2025-08-29T12:00:00Z', 1, 3, 2, 0),
    match(6, '2025-08-29T12:00:00Z', 1, 3, 0, 0)
  ];
  globalThis.fetch = async () => new Response(JSON.stringify({ response: fixtures }));

  try {
    const result = await replayLeagueSeason('1', '2025', 'test-key');
    assert.equal(result.predictions.length, 6);
    assert.equal(result.predictions[0].kickoff, '2025-08-01T12:00:00Z');
    assert.equal(result.predictions[4].kickoff, '2025-08-29T12:00:00Z');
    assert.equal(result.predictions[4].probability, result.predictions[5].probability);
    assert.equal(result.predictions[0].probabilitySource, 'league baseline');
    assert.equal(result.predictions[1].probabilitySource, 'league baseline');
    assert.equal(result.predictions[2].probabilitySource, 'league/team form');
    assert.ok(result.predictions.every((prediction) => Number.isFinite(prediction.probability)));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('replay waits for earlier results and uses the same normalized team rates as the live model', async () => {
  const originalFetch = globalThis.fetch;
  const fixtures = [
    match(1, '2025-08-01T12:00:00Z', 1, 2, 3, 0),
    match(2, '2025-08-01T13:00:00Z', 1, 2, 0, 0),
    match(3, '2025-08-02T12:00:00Z', 1, 2, 0, 0)
  ];
  globalThis.fetch = async () => new Response(JSON.stringify({ response: fixtures }));
  try {
    const result = await replayLeagueSeason('1', '2025', 'test-key');
    assert.equal(result.predictions[1].probability, result.predictions[0].probability);
    assert.equal(result.predictions[1].probabilitySource, 'league baseline');
    assert.equal(result.predictions[2].probabilitySource, 'league/team form');
    const table = buildLeagueTable([
      { team: { id: 1 }, all: { played: 1, goals: { for: 3, against: 0 } }, home: { played: 1, goals: { for: 3, against: 0 } }, form: 'W' },
      { team: { id: 2 }, all: { played: 1, goals: { for: 0, against: 3 } }, away: { played: 1, goals: { for: 0, against: 3 } }, form: 'L' }
    ]);
    const model = estimateMatchGoals({ table, homeRow: table.teams.get('1'), awayRow: table.teams.get('2') });
    assert.equal(result.predictions[2].probability, 1 - Math.exp(-(model.homeGoals + model.awayGoals)));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('calibration report fits on an early split and scores the held-out tail', () => {
  const predictions = Array.from({ length: 100 }, (_, index) => ({
    kickoff: new Date(Date.UTC(2025, 0, index === 70 ? 69 : index)).toISOString(),
    probability: 0.6,
    actual: index % 2 === 0 ? 0 : 1
  }));
  const report = buildCalibrationReport([{
    leagueId: '1',
    league: 'Test League',
    season: 2025,
    fixturesFetched: 100,
    finishedFixtures: 100,
    predictions
  }]);

  const segment = report.seasons[0];
  assert.equal(segment.trainingCount, 71);
  assert.equal(segment.holdoutCount, 29);
  assert.equal(segment.holdout.raw.sampleSize, 29);
  assert.equal(segment.holdout.calibrated.sampleSize, 29);
  assert.ok(segment.logOddsIntercept < 0);
});

test('pooled training excludes future seasons from the held-out period', () => {
  const seasons = [2024, 2025].map((year) => ({
    leagueId: '1', league: 'Test', season: year, fixturesFetched: 100, finishedFixtures: 100,
    predictions: Array.from({ length: 100 }, (_, index) => ({
      kickoff: new Date(Date.UTC(year, 0, index + 1)).toISOString(),
      probability: 0.6,
      actual: year === 2024 ? 1 : 0
    }))
  }));
  const report = buildCalibrationReport(seasons);
  assert.equal(report.pooledHoldout.trainingCount, 140);
  assert.equal(report.pooledHoldout.holdoutCount, 60);
  assert.ok(report.pooledHoldout.logOddsIntercept > 0);
});

function match(id, date, homeId, awayId, homeGoals, awayGoals) {
  return {
    fixture: { id, date, status: { short: 'FT' } },
    league: { name: 'Test League' },
    teams: {
      home: { id: homeId, name: `Team ${homeId}` },
      away: { id: awayId, name: `Team ${awayId}` }
    },
    goals: { home: homeGoals, away: awayGoals }
  };
}
