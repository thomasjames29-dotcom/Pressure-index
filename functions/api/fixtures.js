const API_BASE = 'https://v3.football.api-sports.io';
const CACHE_SECONDS = 600;
const STANDINGS_CACHE_SECONDS = 12 * 60 * 60;
const MAX_STANDINGS_LEAGUES = 8;
const VENUE_RATE_PRIOR_MATCHES = 5;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 2;
export const FIXTURE_MODEL_VERSION = 'venue-poisson-v1';

export async function onRequestGet({ request, env }) {
  if (!env.APIFOOTBALL_KEY) {
    return json({ error: 'Fixture analysis is not configured. Add APIFOOTBALL_KEY to the Pages environment.' }, 503, { 'Cache-Control': 'no-store' });
  }

  const url = new URL(request.url);
  const day = url.searchParams.get('day') === '1' ? 1 : 0;
  const timezone = validTimezone(url.searchParams.get('timezone') || 'Europe/London');
  const now = new Date();
  const range = getLocalWindowForDay(now, timezone, day);
  const cacheKey = new Request(`${url.origin}/api/fixtures?day=${day}&timezone=${encodeURIComponent(timezone)}&anchor=${range.startDate}&model=${FIXTURE_MODEL_VERSION}`);

  try {
    const cached = await caches.default.match(cacheKey);
    if (cached) return cached;
  } catch {
    // Continue if the edge cache is unavailable.
  }

  try {
    const dailyResults = [];
    for (const date of [...new Set([range.startDate, range.endDate])]) {
      dailyResults.push(await apiGet(`/fixtures?date=${encodeURIComponent(date)}&timezone=${encodeURIComponent(timezone)}`, env.APIFOOTBALL_KEY));
    }

    const byId = new Map();
    dailyResults.flat().forEach((fixture) => {
      if (fixture?.fixture?.id !== undefined) byId.set(String(fixture.fixture.id), fixture);
    });
    const upcoming = [...byId.values()].filter((item) => {
      const kickoff = Date.parse(item?.fixture?.date);
      const status = item?.fixture?.status?.short;
      return Number.isFinite(kickoff) && kickoff >= Math.max(range.startMs, now.getTime()) && kickoff < range.endMs
        && !['FT', 'AET', 'PEN', 'CANC', 'ABD', 'PST', 'SUSP', 'INT', 'AWD', 'WO'].includes(status);
    }).sort((a, b) => Date.parse(a.fixture.date) - Date.parse(b.fixture.date));

    const leagueRows = await loadLeagueStandings(upcoming, env.APIFOOTBALL_KEY, url.origin);
    const fixtures = upcoming.map((item) => {
      const leagueId = String(item.league?.id ?? '');
      const season = String(item.league?.season ?? '');
      const table = leagueRows.get(`${leagueId}:${season}`);
      const homeId = String(item.teams?.home?.id ?? '');
      const awayId = String(item.teams?.away?.id ?? '');
      const model = estimateMatchGoals({ table, homeRow: table?.teams.get(homeId), awayRow: table?.teams.get(awayId) });
      const total = model.homeGoals + model.awayGoals;
      const scorelines = buildScorelineSet(model.homeGoals, model.awayGoals);
      const leagueFirstGoalBaselineMinute = expectedFirstGoalMinute(table?.averageTotalGoals || 2.65);
      const matchFirstGoalMinute = expectedFirstGoalMinute(total);
      const expectedMinute = blendFirstGoalMinute(matchFirstGoalMinute, leagueFirstGoalBaselineMinute);
      const orderRecommendation = buildOrderRecommendation(total, expectedMinute || 45);
      const zeroZeroProbability = probabilityZeroZero(model.homeGoals, model.awayGoals);

      return {
        fixtureId: String(item.fixture.id),
        kickoff: item.fixture.date,
        homeTeam: item.teams?.home?.name || 'Home',
        awayTeam: item.teams?.away?.name || 'Away',
        leagueId,
        season,
        modelVersion: FIXTURE_MODEL_VERSION,
        league: item.league?.name || 'Competition',
        country: item.league?.country || '',
        over05Probability: Math.round(probabilityAtLeastOne(total) * 100),
        over05ProbabilityExact: probabilityAtLeastOne(total),
        over15Probability: Math.round(probabilityAtLeastTwo(total) * 100),
        over15ProbabilityExact: probabilityAtLeastTwo(total),
        expectedTotalGoals: round(total, 2),
        firstGoalExpectedMinute: expectedMinute,
        leagueFirstGoalBaselineMinute,
        matchFirstGoalMinute,
        inPlayOver05FairOdds: buildInPlayFairOddsLadder(total),
        inPlayOver05FairOddsAtExpectedMinute: fairOver05OddsAtMinute(total, expectedMinute),
        highGoalPotential: probabilityAtLeastTwo(total) >= 0.60,
        zeroZeroProbability: round(zeroZeroProbability * 100, 1),
        probabilitySource: model.source,
        modelBasis: model.basis,
        modelConfidence: model.confidence,
        scorelines,
        orderRecommendation
      };
    });

    const response = json({
      fixtures,
      generatedAt: now.toISOString(),
      window: { start: range.startMs, end: range.endMs, timezone, day },
      model: 'League/team scoring rates with recent form; xG blended when supplied by provider data.'
    }, 200, {
      'Cache-Control': `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}`,
      'X-Content-Type-Options': 'nosniff'
    });
    try { await caches.default.put(cacheKey, response.clone()); } catch { /* Optional edge cache. */ }
    return response;
  } catch (error) {
    return json({ error: safeMessage(error) }, 502, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  }
}

async function loadLeagueStandings(fixtures, key, origin) {
  const byLeague = new Map();
  const relevant = new Map();
  fixtures.forEach((fixture) => {
    const id = fixture.league?.id;
    const season = fixture.league?.season;
    if (id && season) relevant.set(`${id}:${season}`, { id, season });
  });

  for (const [cacheId, league] of [...relevant.entries()].slice(0, MAX_STANDINGS_LEAGUES)) {
    const cacheKey = new Request(`${origin}/api/model-standings?league=${encodeURIComponent(league.id)}&season=${encodeURIComponent(league.season)}`);
    let rows = null;
    try {
      const cached = await caches.default.match(cacheKey);
      if (cached) rows = (await cached.json()).rows;
    } catch { /* Fetch below if cache is missing or malformed. */ }

    if (!Array.isArray(rows)) {
      try {
        const response = await apiGet(`/standings?league=${encodeURIComponent(league.id)}&season=${encodeURIComponent(league.season)}`, key);
        rows = response?.[0]?.league?.standings?.[0] || [];
        try {
          await caches.default.put(cacheKey, json({ rows }, 200, {
            'Cache-Control': `public, max-age=${STANDINGS_CACHE_SECONDS}, s-maxage=${STANDINGS_CACHE_SECONDS}`
          }));
        } catch { /* Optional cache. */ }
      } catch {
        rows = [];
      }
    }
    byLeague.set(cacheId, buildLeagueTable(rows));
  }
  return byLeague;
}

export function buildLeagueTable(rows) {
  const teams = new Map();
  let goalsFor = 0;
  let playedSum = 0;
  let homeScored = 0;
  let homeConceded = 0;
  let homePlayed = 0;
  let awayScored = 0;
  let awayConceded = 0;
  let awayPlayed = 0;
  let xgForTotal = 0;
  let xgTeamCount = 0;

  for (const row of Array.isArray(rows) ? rows : []) {
    const played = number(row.all?.played);
    const scored = number(row.all?.goals?.for);
    const conceded = number(row.all?.goals?.against);
    if (!row.team?.id || !played || scored === null || conceded === null) continue;
    const xgFor = firstNumber(row.xg?.for, row.expected_goals?.for, row.expectedGoals?.for, row.goals?.xg?.for);
    const xgAgainst = firstNumber(row.xg?.against, row.expected_goals?.against, row.expectedGoals?.against, row.goals?.xg?.against);
    const team = {
      played, scored, conceded, form: formScore(row.form),
      home: {
        played: number(row.home?.played),
        scored: number(row.home?.goals?.for),
        conceded: number(row.home?.goals?.against)
      },
      away: {
        played: number(row.away?.played),
        scored: number(row.away?.goals?.for),
        conceded: number(row.away?.goals?.against)
      },
      xgForPerMatch: xgFor === null ? null : xgFor / played,
      xgAgainstPerMatch: xgAgainst === null ? null : xgAgainst / played
    };
    teams.set(String(row.team.id), team);
    goalsFor += scored;
    playedSum += played;
    if (team.home.played > 0 && team.home.scored !== null && team.home.conceded !== null) {
      homeScored += team.home.scored;
      homeConceded += team.home.conceded;
      homePlayed += team.home.played;
    }
    if (team.away.played > 0 && team.away.scored !== null && team.away.conceded !== null) {
      awayScored += team.away.scored;
      awayConceded += team.away.conceded;
      awayPlayed += team.away.played;
    }
    if (team.xgForPerMatch !== null && team.xgAgainstPerMatch !== null) {
      xgForTotal += xgFor;
      xgTeamCount += played;
    }
  }

  const matches = playedSum / 2;
  const averageTotalGoals = matches > 0 ? goalsFor / matches : 2.65;
  const averageTeamGoals = Math.max(0.35, averageTotalGoals / 2);
  return {
    teams,
    averageTotalGoals,
    averageTeamGoals,
    averageHomeGoals: homePlayed ? homeScored / homePlayed : averageTeamGoals * 1.08,
    averageHomeGoalsAgainst: homePlayed ? homeConceded / homePlayed : averageTeamGoals * 0.92,
    averageAwayGoals: awayPlayed ? awayScored / awayPlayed : averageTeamGoals * 0.92,
    averageAwayGoalsAgainst: awayPlayed ? awayConceded / awayPlayed : averageTeamGoals * 1.08,
    averageXgFor: xgTeamCount ? xgForTotal / xgTeamCount : null
  };
}

export function estimateMatchGoals({ table, homeRow, awayRow }) {
  const league = table || buildLeagueTable([]);
  if (!homeRow || !awayRow || !homeRow.played || !awayRow.played) {
    const total = clamp(league.averageTotalGoals || 2.65, 1.4, 4.2);
    return { homeGoals: total * 0.54, awayGoals: total * 0.46, source: 'league baseline', basis: 'League scoring average; team data unavailable', confidence: 'low' };
  }

  const attackHome = relativeVenueRate(homeRow, 'home', 'scored', league.averageHomeGoals);
  const defenceAway = relativeVenueRate(awayRow, 'away', 'conceded', league.averageHomeGoalsAgainst);
  const attackAway = relativeVenueRate(awayRow, 'away', 'scored', league.averageAwayGoals);
  const defenceHome = relativeVenueRate(homeRow, 'home', 'conceded', league.averageAwayGoalsAgainst);
  let homeGoals = league.averageHomeGoals * attackHome * defenceAway * formMultiplier(homeRow.form);
  let awayGoals = league.averageAwayGoals * attackAway * defenceHome * formMultiplier(awayRow.form);

  let usedXg = false;
  if (homeRow.xgForPerMatch !== null && awayRow.xgAgainstPerMatch !== null && league.averageXgFor > 0) {
    const homeXg = league.averageHomeGoals
      * (shrinkRate(homeRow.xgForPerMatch, homeRow.played, league.averageXgFor) / league.averageXgFor)
      * (shrinkRate(awayRow.xgAgainstPerMatch, awayRow.played, league.averageXgFor) / league.averageXgFor);
    homeGoals = homeGoals * 0.7 + clamp(homeXg, 0.2, 4.5) * 0.3;
    usedXg = true;
  }
  if (awayRow.xgForPerMatch !== null && homeRow.xgAgainstPerMatch !== null && league.averageXgFor > 0) {
    const awayXg = league.averageAwayGoals
      * (shrinkRate(awayRow.xgForPerMatch, awayRow.played, league.averageXgFor) / league.averageXgFor)
      * (shrinkRate(homeRow.xgAgainstPerMatch, homeRow.played, league.averageXgFor) / league.averageXgFor);
    awayGoals = awayGoals * 0.7 + clamp(awayXg, 0.2, 4.5) * 0.3;
    usedXg = true;
  }
  homeGoals = clamp(homeGoals, 0.15, 4.5);
  awayGoals = clamp(awayGoals, 0.15, 4.5);
  return {
    homeGoals, awayGoals,
    source: usedXg ? 'league/team form + xG' : 'league/team form',
    basis: `${usedXg ? 'League average, team attack/defence, recent form and available xG' : 'League average, team attack/defence and recent form'} · ${homeRow.played}/${awayRow.played} matches played`,
    confidence: Math.min(homeRow.played, awayRow.played) >= 10
      && Math.min(homeRow.home?.played ?? homeRow.played, awayRow.away?.played ?? awayRow.played) >= 6
      ? 'medium'
      : 'low'
  };
}
function relativeVenueRate(row, venue, metric, leagueRate) {
  if (leagueRate <= 0) return 1;
  return clamp(venueRate(row, venue, metric, leagueRate) / leagueRate, 0.55, 1.55);
}
function venueRate(row, venue, metric, leagueRate) {
  const played = row[venue]?.played;
  const goals = row[venue]?.[metric];
  const rate = played > 0 && goals != null ? goals / played : row[metric] / row.played;
  const sampleSize = played > 0 && goals != null ? played : row.played;
  const priorRate = leagueRate > 0 ? leagueRate : rate;
  return shrinkRate(rate, sampleSize, priorRate);
}
function shrinkRate(rate, sampleSize, priorRate) {
  return ((rate * sampleSize) + (priorRate * VENUE_RATE_PRIOR_MATCHES)) / (sampleSize + VENUE_RATE_PRIOR_MATCHES);
}

function formScore(value) {
  if (typeof value !== 'string' || !value.length) return null;
  const points = [...value.toUpperCase()].slice(-5).map((result) => result === 'W' ? 1 : result === 'D' ? 0.5 : result === 'L' ? 0 : null).filter((point) => point !== null);
  return points.length ? points.reduce((sum, point) => sum + point, 0) / points.length : null;
}
function formMultiplier(score) { return score === null ? 1 : clamp(1 + (score - 0.5) * 0.24, 0.88, 1.12); }

function buildScorelineSet(homeExpected, awayExpected) {
  const results = [];
  for (let home = 0; home <= 6; home += 1) {
    for (let away = 0; away <= 6; away += 1) {
      results.push({ label: `${home}-${away}`, probability: poisson(home, homeExpected) * poisson(away, awayExpected) * 100 });
    }
  }
  return results.sort((a, b) => b.probability - a.probability).slice(0, 3);
}
function poisson(goals, expected) {
  let factorial = 1;
  for (let i = 2; i <= goals; i += 1) factorial *= i;
  return Math.exp(-expected) * (expected ** goals) / factorial;
}
function probabilityAtLeastOne(expected) { return 1 - Math.exp(-expected); }
function probabilityAtLeastTwo(expected) { return 1 - Math.exp(-expected) * (1 + expected); }
export function probabilityZeroZero(homeExpected, awayExpected) { return Math.exp(-(homeExpected + awayExpected)); }
function expectedFirstGoalMinute(total) {
  if (total <= 0.0001) return null;
  return clamp(Math.round(90 / total - 90 / Math.expm1(total)), 1, 89);
}
function blendFirstGoalMinute(matchMinute, leagueMinute) {
  if (matchMinute === null) return leagueMinute;
  if (leagueMinute === null) return matchMinute;
  return clamp(Math.round(matchMinute * 0.7 + leagueMinute * 0.3), 1, 89);
}
function fairOver05OddsAtMinute(expectedGoals, minute) {
  if (minute === null) return null;
  const remaining = expectedGoals * (90 - minute) / 90;
  const probability = probabilityAtLeastOne(remaining);
  return probability > 0 ? round(1 / probability, 2) : null;
}
function buildInPlayFairOddsLadder(expectedGoals) {
  return [15, 30, 45, 60, 75].map((minute) => {
    const remaining = expectedGoals * (90 - minute) / 90;
    const probability = probabilityAtLeastOne(remaining);
    return { minute, probability: round(probability * 100, 1), fairOdds: probability > 0 ? round(1 / probability, 2) : null };
  });
}

export function buildOrderRecommendation(expectedGoals, minute, config = {}) {
  const lossRate = Number.isFinite(config.lossRate) ? config.lossRate : 0.20;
  const commissionRate = Number.isFinite(config.commissionRate) ? config.commissionRate : 0.05;
  const minEv = Number.isFinite(config.minEv) ? config.minEv : 0.02;
  const minKelly = Number.isFinite(config.minKelly) ? config.minKelly : 0.005;
  const minuteSteps = Array.isArray(config.minutes) ? config.minutes : [15, 30, 45, 60, 75];

  const candidates = minuteSteps.map((step) => {
    const remaining = expectedGoals * (90 - step) / 90;
    const probability = probabilityAtLeastOne(remaining);
    const fairOdds = probability > 0 ? round(1 / probability, 2) : null;
    const adjustedWinProbability = clamp(probability - lossRate, 0.01, 0.99);
    const rawTargetOdds = adjustedWinProbability > 0 && commissionRate < 1
      ? 1 + ((1 - adjustedWinProbability + minEv) / (adjustedWinProbability * (1 - commissionRate)))
      : null;
    const targetOdds = rawTargetOdds !== null ? Math.ceil(rawTargetOdds * 100) / 100 : null;
    const netOdds = targetOdds !== null ? 1 + (targetOdds - 1) * (1 - commissionRate) : null;
    const expectedValue = targetOdds !== null && netOdds !== null
      ? round((adjustedWinProbability * (netOdds - 1)) - (1 - adjustedWinProbability), 3)
      : null;
    const kellyFraction = targetOdds !== null && netOdds !== null && netOdds > 1
      ? round(Math.max(0, ((adjustedWinProbability * (netOdds - 1)) - (1 - adjustedWinProbability)) / (netOdds - 1)), 4)
      : null;

    return {
      minute: step,
      fairOdds,
      targetOdds,
      expectedValue,
      kellyFraction,
      probability: round(probability * 100, 1),
      riskAdjustedProbability: round(adjustedWinProbability * 100, 1),
      lossRate,
      commissionRate
    };
  }).filter((candidate) => candidate.targetOdds !== null && Number.isFinite(candidate.expectedValue) && candidate.expectedValue >= minEv && candidate.kellyFraction > minKelly);

  const best = candidates.sort((a, b) => Number(b.expectedValue) - Number(a.expectedValue) || Number(b.kellyFraction) - Number(a.kellyFraction))[0];

  if (!best) {
    return {
      minute: null,
      fairOdds: null,
      targetOdds: null,
      expectedValue: null,
      kellyFraction: null,
      probability: null,
      riskAdjustedProbability: null,
      lossRate,
      commissionRate,
      strategy: 'No profitable edge under the current loss and commission assumptions.'
    };
  }

  const chosenMinute = Number.isFinite(minute) ? minute : best.minute;
  const selected = candidates.find((candidate) => candidate.minute === chosenMinute) || best;

  return {
    minute: selected.minute,
    fairOdds: selected.fairOdds,
    targetOdds: selected.targetOdds,
    expectedValue: selected.expectedValue,
    kellyFraction: selected.kellyFraction,
    probability: selected.probability,
    riskAdjustedProbability: selected.riskAdjustedProbability,
    lossRate,
    commissionRate,
    strategy: 'Minimum 0-0 over 0.5 price for the configured expected-value hurdle; compare with an available market price.'
  };
}

function number(value) { if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null; const result = Number(value); return Number.isFinite(result) ? result : null; }
function firstNumber(...values) { for (const value of values) { const result = number(value); if (result !== null) return result; } return null; }
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function round(value, places) { const scale = 10 ** places; return Math.round(value * scale) / scale; }
function validTimezone(candidate) { try { new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date()); return candidate; } catch { return 'Europe/London'; } }

function getLocalWindowForDay(now, timezone, offset) {
  const parts = getLocalParts(now, timezone);
  const currentDate = dateKey(now, timezone);
  const startDate = addDays(parts.hour >= 8 ? currentDate : addDays(currentDate, -1), offset);
  const endDate = addDays(startDate, 1);
  return { startDate, endDate, startMs: localTimeToUtc(startDate, 8, timezone), endMs: localTimeToUtc(endDate, 8, timezone) };
}
function getLocalParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const map = {};
  for (const part of parts) if (part.type !== 'literal') map[part.type] = part.value;
  return { year: Number(map.year), month: Number(map.month), day: Number(map.day), hour: Number(map.hour) };
}
function dateKey(date, timezone) { const { year, month, day } = getLocalParts(date, timezone); return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`; }
function addDays(value, amount) {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + amount));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}
function localTimeToUtc(value, hour, timezone) {
  const [year, month, day] = value.split('-').map(Number);
  const target = Date.UTC(year, month - 1, day, hour);
  let guess = target;
  for (let i = 0; i < 3; i += 1) {
    const local = getLocalParts(new Date(guess), timezone);
    guess += target - Date.UTC(local.year, local.month - 1, local.day, local.hour);
  }
  return guess;
}

async function apiGet(path, key) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${API_BASE}${path}`, { headers: { 'x-apisports-key': key, Accept: 'application/json' }, signal: controller.signal });
      const payload = await response.json().catch(() => ({}));
      const errors = payload.errors && typeof payload.errors === 'object' ? Object.values(payload.errors).filter(Boolean) : [];
      if (response.ok && errors.length === 0) return Array.isArray(payload.response) ? payload.response : [];
      const message = errors.map(String).join(' · ') || `API-Football returned HTTP ${response.status}`;
      if (response.status === 429 || /rate limit|too many requests|quota/i.test(message)) throw new Error(message);
      if (attempt < MAX_RETRIES && (response.status >= 500 || response.status === 408)) { await sleep(500 * (2 ** attempt)); continue; }
      throw new Error(message);
    } catch (error) {
      if (error instanceof Error && (error.name === 'AbortError' || /network|fetch|timeout/i.test(error.message)) && attempt < MAX_RETRIES) {
        await sleep(500 * (2 ** attempt)); continue;
      }
      throw error;
    } finally { clearTimeout(timer); }
  }
  throw new Error('API-Football is unavailable after retries.');
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function safeMessage(error) { return error instanceof Error ? error.message.slice(0, 240) : 'The fixture request failed.'; }
function json(value, status, extraHeaders = {}) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders } }); }
