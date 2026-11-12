import test from 'node:test';
import assert from 'node:assert/strict';
import { applyBrowserCalibration } from '../lib/browser-calibration.mjs';

const fixture = {
  leagueId: '39',
  season: '2026',
  kickoff: '2026-09-01T12:00:00Z',
  modelVersion: 'venue-poisson-v1',
  probabilitySource: 'league/team form',
  over05ProbabilityExact: 0.8,
  over05Probability: 80,
  zeroZeroProbability: 20,
  over15Probability: 60,
  over15ProbabilityExact: 0.6,
  inPlayOver05FairOddsAtExpectedMinute: 1.7
};
const calibration = {
  season: 2025,
  modelVersion: 'venue-poisson-v1',
  lastResultAvailableAt: '2026-06-01T12:00:00Z',
  intercept: Math.log(2)
};

test('browser calibration updates only over 0.5 and its 0-0 complement', () => {
  const adjusted = applyBrowserCalibration(fixture, calibration);
  assert.equal(adjusted.over05Probability, 89);
  assert.equal(adjusted.zeroZeroProbability, 11.1);
  assert.equal(adjusted.over15Probability, 60);
  assert.equal(adjusted.inPlayOver05FairOddsAtExpectedMinute, 1.7);
  assert.equal(adjusted.calibrationSeason, 2025);
  assert.equal(fixture.over05Probability, 80);
});

test('browser calibration excludes future data, different models, old seasons and xG', () => {
  for (const change of [
    { kickoff: '2026-06-01T12:00:00Z' },
    { modelVersion: 'other' },
    { season: '2027' },
    { season: '2024' },
    { probabilitySource: 'league/team form + xG' }
  ]) {
    const original = { ...fixture, ...change };
    assert.equal(applyBrowserCalibration(original, calibration), original);
  }
  assert.equal(applyBrowserCalibration(fixture, { ...calibration, intercept: -3 }), fixture);
});
