import { buildLeagueTable, estimateMatchGoals, FIXTURE_MODEL_VERSION } from './fixtures.js';
import { buildCalibrationReport, replayLeagueSeason } from '../../lib/fixture-calibration.mjs';

const CACHE_SECONDS = 12 * 60 * 60;
const MIN_TRAINING = 100;
const MIN_HOLDOUT = 40;

export async function onRequestGet({ request, env }) {
  if (!env.APIFOOTBALL_KEY) return json({ error: 'Calibration requires APIFOOTBALL_KEY in the Pages environment.' }, 503);

  const url = new URL(request.url);
  const leagueId = url.searchParams.get('league') || '';
  const season = url.searchParams.get('season') || '';
  const currentYear = new Date().getUTCFullYear();
  if (!/^[1-9]\d{0,4}$/.test(leagueId) || !/^\d{4}$/.test(season) || Number(season) < 2000 || Number(season) > currentYear) {
    return json({ error: 'Provide a valid league ID and season starting year.' }, 400);
  }

  const cacheKey = new Request(`${url.origin}/api/calibration?league=${leagueId}&season=${season}&model=${FIXTURE_MODEL_VERSION}`);
  try {
    const cached = await caches.default.match(cacheKey);
    if (cached) return cached;
  } catch { /* Continue without edge cache. */ }

  try {
    const replay = await replayLeagueSeason(leagueId, season, env.APIFOOTBALL_KEY, { buildLeagueTable, estimateMatchGoals });
    const report = buildCalibrationReport([replay]).seasons[0];
    const raw = report.holdout.raw;
    const calibrated = report.holdout.calibrated;
    const eligible = report.trainingCount >= MIN_TRAINING && report.holdoutCount >= MIN_HOLDOUT
      && Number.isFinite(report.logOddsIntercept) && raw && calibrated
      && calibrated.brierScore < raw.brierScore && calibrated.logLoss < raw.logLoss;
    const response = json({
      leagueId,
      season: Number(season),
      modelVersion: FIXTURE_MODEL_VERSION,
      league: report.league,
      lastResultAvailableAt: report.lastResultAvailableAt,
      trainingCount: report.trainingCount,
      holdoutCount: report.holdoutCount,
      raw,
      calibrated,
      intercept: eligible ? report.logOddsIntercept : null,
      eligible: Boolean(eligible),
      minimumTraining: MIN_TRAINING,
      minimumHoldout: MIN_HOLDOUT
    }, 200, `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}`);
    try { await caches.default.put(cacheKey, response.clone()); } catch { /* Continue without edge cache. */ }
    return response;
  } catch (error) {
    return json({ error: error instanceof Error ? error.message.slice(0, 240) : 'Calibration replay failed.' }, 502);
  }
}

function json(value, status, cacheControl = 'no-store') {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cacheControl,
      'X-Content-Type-Options': 'nosniff'
    }
  });
}
