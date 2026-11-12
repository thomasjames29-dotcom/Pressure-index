const API_BASE = 'https://v3.football.api-sports.io';
const API_TIMEOUT_MS = 15_000;
const HOLDOUT_FRACTION = 0.3;
const MIN_TRAINING_FIXTURES = 30;
const CALIBRATION_BINS = 10;
const RESULT_AVAILABILITY_DELAY_MS = 24 * 60 * 60 * 1000;

export async function replayLeagueSeason(leagueId, season, key, { buildLeagueTable, estimateMatchGoals }) {
  const fixtures = await fetchSeasonFixtures(leagueId, season, key);
  const finished = fixtures
    .filter((fixture) => isReplayableFixture(fixture) && Number.isFinite(Date.parse(fixture.fixture.date)))
    .sort((a, b) => Date.parse(a.fixture.date) - Date.parse(b.fixture.date));
  if (!finished.length) throw new Error(`No completed, scored fixtures available for league ${leagueId}, season ${season}.`);
  const teams = new Map();
  const predictions = [];
  let completedIndex = 0;

  for (let index = 0; index < finished.length;) {
    const kickoff = Date.parse(finished[index].fixture.date);
    while (completedIndex < index && Date.parse(finished[completedIndex].fixture.date) + RESULT_AVAILABILITY_DELAY_MS <= kickoff) {
      const completed = finished[completedIndex++];
      recordResult(teamState(teams, String(completed.teams.home.id)), Number(completed.goals.home), Number(completed.goals.away), true);
      recordResult(teamState(teams, String(completed.teams.away.id)), Number(completed.goals.away), Number(completed.goals.home), false);
    }
    let end = index + 1;
    while (end < finished.length && Date.parse(finished[end].fixture.date) === kickoff) end += 1;
    const simultaneous = finished.slice(index, end);

    for (const fixture of simultaneous) {
      const homeId = String(fixture.teams.home.id);
      const awayId = String(fixture.teams.away.id);
      const table = buildLeagueTable([...teams].map(([id, state]) => standingsRow(id, state)));
      const estimate = estimateMatchGoals({
        table,
        homeRow: table.teams.get(homeId),
        awayRow: table.teams.get(awayId)
      });
      const expectedGoals = estimate.homeGoals + estimate.awayGoals;
      const goals = Number(fixture.goals.home) + Number(fixture.goals.away);
      if (!Number.isFinite(expectedGoals)) throw new Error(`Non-finite model output for fixture ${fixture.fixture.id}.`);
      predictions.push({
        kickoff: fixture.fixture.date,
        probability: 1 - Math.exp(-expectedGoals),
        actual: goals > 0 ? 1 : 0,
        over15Probability: 1 - Math.exp(-expectedGoals) * (1 + expectedGoals),
        over15Actual: goals > 1 ? 1 : 0,
        probabilitySource: estimate.source,
        homeTeam: fixture.teams.home.name,
        awayTeam: fixture.teams.away.name
      });
    }
    index = end;
  }

  return {
    leagueId: String(leagueId),
    season: Number(season),
    league: finished[0]?.league?.name || `League ${leagueId}`,
    fixturesFetched: fixtures.length,
    finishedFixtures: finished.length,
    lastResultAvailableAt: new Date(Date.parse(finished[finished.length - 1].fixture.date) + RESULT_AVAILABILITY_DELAY_MS).toISOString(),
    predictions
  };
}

export function buildCalibrationReport(seasons) {
  const segments = seasons.map((season) => {
    const predictions = season.predictions;
    const splitIndex = chronologicalSplitIndex(predictions);
    const holdout = predictions.slice(splitIndex);
    const training = availableTraining(predictions, splitIndex);
    const intercept = training.length >= MIN_TRAINING_FIXTURES
      ? fitLogitIntercept(training)
      : null;
    const rawMetrics = evaluate(holdout, (prediction) => prediction.probability);
    const calibratedMetrics = intercept === null
      ? null
      : evaluate(holdout, (prediction) => calibrateProbability(prediction.probability, intercept));

    return {
      leagueId: season.leagueId,
      league: season.league,
      season: season.season,
      fixturesFetched: season.fixturesFetched,
      finishedFixtures: season.finishedFixtures,
      lastResultAvailableAt: season.lastResultAvailableAt,
      predictionCount: predictions.length,
      teamModelCount: predictions.filter((prediction) => prediction.probabilitySource !== 'league baseline').length,
      trainingCount: training.length,
      holdoutCount: holdout.length,
      calibration: intercept === null
        ? 'Not fitted: fewer than 30 training fixtures.'
        : 'Log-odds intercept fitted on the first 70%; metrics below are the final 30%.',
      logOddsIntercept: intercept,
      holdout: {
        raw: rawMetrics,
        calibrated: calibratedMetrics,
        rawBins: calibrationBins(holdout, (prediction) => prediction.probability),
        calibratedBins: intercept === null ? null : calibrationBins(
          holdout,
          (prediction) => calibrateProbability(prediction.probability, intercept)
        ),
        over15Raw: evaluateOver15(holdout)
      }
    };
  });

  const pooled = seasons.flatMap((season) => season.predictions)
    .sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));
  const pooledSplit = chronologicalSplitIndex(pooled);
  const pooledTraining = availableTraining(pooled, pooledSplit);
  const pooledHoldout = pooled.slice(pooledSplit);
  const pooledIntercept = pooledTraining.length >= MIN_TRAINING_FIXTURES
    ? fitLogitIntercept(pooledTraining)
    : null;

  return {
    generatedAt: new Date().toISOString(),
    method: 'Chronological replay; results are assumed available 24 hours after kickoff. Approximately the first 70% trains an intercept-only log-odds calibrator; the remainder is held out.',
    target: 'At least one goal (over 0.5)',
    seasons: segments,
    pooledHoldout: {
      trainingCount: pooledTraining.length,
      holdoutCount: pooledHoldout.length,
      logOddsIntercept: pooledIntercept,
      raw: evaluate(pooledHoldout, (prediction) => prediction.probability),
      calibrated: pooledIntercept === null
        ? null
        : evaluate(pooledHoldout, (prediction) => calibrateProbability(prediction.probability, pooledIntercept)),
      rawBins: calibrationBins(pooledHoldout, (prediction) => prediction.probability),
      calibratedBins: pooledIntercept === null
        ? null
        : calibrationBins(pooledHoldout, (prediction) => calibrateProbability(prediction.probability, pooledIntercept)),
      over15Raw: evaluateOver15(pooledHoldout)
    }
  };
}

function isReplayableFixture(fixture) {
  return fixture?.fixture?.status?.short === 'FT'
    && fixture.fixture.date
    && fixture.teams?.home?.id
    && fixture.teams?.away?.id
    && isGoalCount(fixture.goals?.home)
    && isGoalCount(fixture.goals?.away);
}

function isGoalCount(value) {
  return value !== null && value !== undefined && String(value).trim() !== ''
    && Number.isInteger(Number(value)) && Number(value) >= 0;
}

function teamState(teams, id) {
  if (!teams.has(id)) {
    teams.set(id, {
      played: 0,
      scored: 0,
      conceded: 0,
      home: { played: 0, scored: 0, conceded: 0 },
      away: { played: 0, scored: 0, conceded: 0 },
      form: []
    });
  }
  return teams.get(id);
}

function recordResult(team, scored, conceded, atHome) {
  team.played += 1;
  team.scored += scored;
  team.conceded += conceded;
  const venue = atHome ? team.home : team.away;
  venue.played += 1;
  venue.scored += scored;
  venue.conceded += conceded;
  team.form.push(scored > conceded ? 'W' : scored === conceded ? 'D' : 'L');
}

function standingsRow(id, team) {
  return {
    team: { id },
    all: {
      played: team.played,
      goals: { for: team.scored, against: team.conceded }
    },
    home: {
      played: team.home.played,
      goals: { for: team.home.scored, against: team.home.conceded }
    },
    away: {
      played: team.away.played,
      goals: { for: team.away.scored, against: team.away.conceded }
    },
    form: team.form.slice(-5).join('')
  };
}

async function fetchSeasonFixtures(leagueId, season, key) {
  const url = new URL(`${API_BASE}/fixtures`);
  url.searchParams.set('league', leagueId);
  url.searchParams.set('season', season);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { 'x-apisports-key': key, Accept: 'application/json' },
      signal: controller.signal
    });
    const payload = await response.json().catch(() => ({}));
    const errors = payload.errors && typeof payload.errors === 'object'
      ? Object.values(payload.errors).filter(Boolean)
      : [];
    if (!response.ok || errors.length) {
      throw new Error(errors.map(String).join(' · ') || `API-Football returned HTTP ${response.status}`);
    }
    if (!Array.isArray(payload.response)) throw new Error('API-Football returned an invalid fixtures response.');
    if (Number(payload.paging?.total) > 1) throw new Error('API-Football returned multiple pages; replay requires a complete season.');
    return payload.response;
  } finally {
    clearTimeout(timer);
  }
}

function fitLogitIntercept(predictions) {
  let intercept = 0;
  for (let iteration = 0; iteration < 50; iteration += 1) {
    let gradient = 0;
    let hessian = 0;
    for (const prediction of predictions) {
      const probability = calibrateProbability(prediction.probability, intercept);
      gradient += prediction.actual - probability;
      hessian += probability * (1 - probability);
    }
    if (hessian < 1e-9) break;
    const step = gradient / hessian;
    intercept = Math.max(-4, Math.min(4, intercept + step));
    if (Math.abs(step) < 1e-7) break;
  }
  return intercept;
}

function calibrateProbability(probability, intercept) {
  const bounded = Math.max(1e-6, Math.min(1 - 1e-6, probability));
  const logit = Math.log(bounded / (1 - bounded)) + intercept;
  return 1 / (1 + Math.exp(-logit));
}

function chronologicalSplitIndex(predictions) {
  let splitIndex = Math.floor(predictions.length * (1 - HOLDOUT_FRACTION));
  if (splitIndex > 0 && splitIndex < predictions.length) {
    const previousKickoff = Date.parse(predictions[splitIndex - 1].kickoff);
    const nextKickoff = Date.parse(predictions[splitIndex].kickoff);
    if (Number.isFinite(previousKickoff) && previousKickoff === nextKickoff) {
      while (
        splitIndex < predictions.length
        && Date.parse(predictions[splitIndex].kickoff) === previousKickoff
      ) splitIndex += 1;
    }
  }
  return splitIndex;
}

function availableTraining(predictions, splitIndex) {
  const firstHoldoutKickoff = Date.parse(predictions[splitIndex]?.kickoff);
  return predictions.slice(0, splitIndex).filter((prediction) => {
    const kickoff = Date.parse(prediction.kickoff);
    return !Number.isFinite(firstHoldoutKickoff) || (Number.isFinite(kickoff) && kickoff + RESULT_AVAILABILITY_DELAY_MS <= firstHoldoutKickoff);
  });
}

function evaluate(predictions, getProbability) {
  if (!predictions.length) return null;
  let brier = 0;
  let logLoss = 0;
  let observedRate = 0;
  for (const prediction of predictions) {
    const probability = Math.max(1e-6, Math.min(1 - 1e-6, getProbability(prediction)));
    brier += (probability - prediction.actual) ** 2;
    logLoss -= prediction.actual * Math.log(probability)
      + (1 - prediction.actual) * Math.log(1 - probability);
    observedRate += prediction.actual;
  }
  return {
    sampleSize: predictions.length,
    brierScore: round(brier / predictions.length, 5),
    logLoss: round(logLoss / predictions.length, 5),
    observedRate: round(observedRate / predictions.length, 5),
    bins: calibrationBins(predictions, getProbability)
  };
}

function evaluateOver15(predictions) {
  const rows = predictions
    .filter((prediction) => Number.isFinite(prediction.over15Probability) && (prediction.over15Actual === 0 || prediction.over15Actual === 1))
    .map((prediction) => ({ probability: prediction.over15Probability, actual: prediction.over15Actual }));
  return evaluate(rows, (prediction) => prediction.probability);
}

function calibrationBins(predictions, getProbability) {
  const bins = Array.from({ length: CALIBRATION_BINS }, (_, index) => ({
    lower: index / CALIBRATION_BINS,
    upper: (index + 1) / CALIBRATION_BINS,
    count: 0,
    predictedRate: 0,
    observedRate: 0
  }));
  for (const prediction of predictions) {
    const probability = Math.max(0, Math.min(1 - Number.EPSILON, getProbability(prediction)));
    const bin = bins[Math.floor(probability * CALIBRATION_BINS)];
    bin.count += 1;
    bin.predictedRate += probability;
    bin.observedRate += prediction.actual;
  }
  return bins
    .filter((bin) => bin.count)
    .map((bin) => ({
      lower: round(bin.lower, 1),
      upper: round(bin.upper, 1),
      count: bin.count,
      predictedRate: round(bin.predictedRate / bin.count, 5),
      observedRate: round(bin.observedRate / bin.count, 5)
    }));
}

function round(value, places) {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}
