import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLeagueTable, estimateMatchGoals, buildOrderRecommendation, probabilityZeroZero } from '../functions/api/fixtures.js';

const standings = [
  {
    team: { id: 1 }, all: { played: 10, goals: { for: 15, against: 10 } },
    home: { played: 5, goals: { for: 10, against: 4 } },
    away: { played: 5, goals: { for: 5, against: 6 } }
  },
  {
    team: { id: 2 }, all: { played: 10, goals: { for: 10, against: 15 } },
    home: { played: 5, goals: { for: 4, against: 8 } },
    away: { played: 5, goals: { for: 6, against: 7 } }
  }
];

test('league baselines use actual home and away standings when available', () => {
  const table = buildLeagueTable(standings);

  assert.equal(table.averageHomeGoals, 1.4);
  assert.equal(table.averageHomeGoalsAgainst, 1.2);
  assert.equal(table.averageAwayGoals, 1.1);
  assert.equal(table.averageAwayGoalsAgainst, 1.3);
});

test('missing venue splits fall back to the existing league averages', () => {
  const table = buildLeagueTable([{
    team: { id: 1 }, all: { played: 10, goals: { for: 15, against: 10 } }
  }]);

  assert.equal(table.averageHomeGoals, table.averageTeamGoals * 1.08);
  assert.equal(table.averageAwayGoals, table.averageTeamGoals * 0.92);
});

test('match estimates use venue-specific team rates', () => {
  const table = buildLeagueTable(standings);
  const result = estimateMatchGoals({
    table,
    homeRow: table.teams.get('1'),
    awayRow: table.teams.get('2')
  });

  assert.ok(Math.abs(result.homeGoals - (1.4 * (1.7 / 1.4) * (1.3 / 1.2))) < 1e-10);
  assert.ok(Math.abs(result.awayGoals - (1.1 * (1.15 / 1.1) * (1.05 / 1.3))) < 1e-10);
  assert.equal(result.confidence, 'low');
});

test('0-0 probability is the exact independent-Poisson probability', () => {
  assert.equal(probabilityZeroZero(1.3, 0.9), Math.exp(-2.2));
});

test('a goalless early-season table produces finite estimates', () => {
  const rows = [1, 2].map((id) => ({
    team: { id }, all: { played: 1, goals: { for: 0, against: 0 } },
    home: { played: id === 1 ? 1 : 0, goals: { for: 0, against: 0 } },
    away: { played: id === 2 ? 1 : 0, goals: { for: 0, against: 0 } }
  }));
  const table = buildLeagueTable(rows);
  const result = estimateMatchGoals({ table, homeRow: table.teams.get('1'), awayRow: table.teams.get('2') });
  assert.ok(Number.isFinite(result.homeGoals));
  assert.ok(Number.isFinite(result.awayGoals));
});

test('missing xG is not treated as zero and alternative xG fields are recognized', () => {
  const rows = standings.map((row) => ({
    ...row, xg: { for: null, against: null },
    expected_goals: { for: 12, against: 10 }
  }));
  const table = buildLeagueTable(rows);
  assert.equal(table.teams.get('1').xgForPerMatch, 1.2);
  assert.equal(table.teams.get('1').xgAgainstPerMatch, 1);
  const result = estimateMatchGoals({ table, homeRow: table.teams.get('1'), awayRow: table.teams.get('2') });
  assert.equal(result.source, 'league/team form + xG');
  const goalRateEstimate = 1.4 * (1.7 / 1.4) * (1.3 / 1.2);
  const shrunkXgAgainst = (10 * 1 + 5 * 1.2) / 15;
  assert.ok(Math.abs(result.homeGoals - (goalRateEstimate * 0.7 + 1.4 * (shrunkXgAgainst / 1.2) * 0.3)) < 1e-10);
});

test('minimum odds account for commission and apply the probability haircut once', () => {
  const recommendation = buildOrderRecommendation(2.4, 30, {
    lossRate: 0.05,
    commissionRate: 0.05,
    minEv: 0.02,
    minKelly: 0,
    minutes: [30]
  });

  assert.ok(recommendation.targetOdds > recommendation.fairOdds);
  assert.ok(recommendation.expectedValue >= 0.02);
  assert.ok(recommendation.kellyFraction > 0);
});
