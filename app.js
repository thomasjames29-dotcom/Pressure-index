const REFRESH_MS = 60_000;
const PRESSURE_WINDOW_MINUTES = 12;
const HISTORY_LIMIT = 130;
const FIXTURE_CACHE_TTL_MS = 3 * 60_000;
const HISTORY_STORAGE_KEY = 'pressure-index-match-pressure-v2';
const STATS_STORAGE_KEY = 'pressure-index-last-good-stats-v1';
const FIXTURES_STORAGE_KEY = 'pressure-index-last-live-fixtures-v1';
const $ = (selector) => document.querySelector(selector);
const body = $('#matchesBody');
const notice = $('#notice');
const statusText = $('#statusText');
const updatedAt = $('#updatedAt');
let refreshTimer;
let refreshing = false;
let currentMatches = [];
const pressureHistory = loadMap(HISTORY_STORAGE_KEY);
const lastGoodStats = loadMap(STATS_STORAGE_KEY);
const lastLiveFixtures = loadMap(FIXTURES_STORAGE_KEY);

const statAliases = {
  shots: ['Total Shots', 'Shots'],
  onTarget: ['Shots on Goal', 'Shots on Target'],
  corners: ['Corner Kicks', 'Corners'],
  dangerous: ['Dangerous Attacks'],
  possession: ['Ball Possession']
};

function loadMap(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '{}');
    return new Map(Object.entries(value));
  } catch {
    return new Map();
  }
}

function saveMap(key, map) {
  try {
    localStorage.setItem(key, JSON.stringify(Object.fromEntries(map)));
  } catch {
    // Continue with in-memory data if storage is unavailable or full.
  }
}

async function runRefresh() {
  if (refreshing) return;
  refreshing = true;
  statusText.textContent = 'Updating live games…';
  try {
    const response = await fetch('/api/live', { headers: { Accept: 'application/json' } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Service returned ${response.status}`);
    let matches = Array.isArray(payload.matches) ? payload.matches : [];
    const recovered = matches.length === 0 ? getRecentlyMissingFixtures() : [];
    if (recovered.length) matches = recovered;
    matches = matches.map(useLatestGoodStats);
    if (Array.isArray(payload.matches) && payload.matches.length) cacheFixtures(matches);
    currentMatches = matches;

    matches.forEach(updatePressureHistory);
    saveMap(HISTORY_STORAGE_KEY, pressureHistory);
    saveMap(STATS_STORAGE_KEY, lastGoodStats);
    saveMap(FIXTURES_STORAGE_KEY, lastLiveFixtures);
    matches.sort((a, b) => pressureFor(b).score - pressureFor(a).score);
    renderMatches(matches);

    const now = new Date();
    statusText.textContent = recovered.length ? 'Showing recently cached fixtures' : 'Live data connected';
    updatedAt.textContent = `Updated ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    $('#matchCount').textContent = String(matches.length);
    notice.textContent = matches.length
      ? `${recovered.length ? 'Live fixture response was empty; temporarily showing the last successful scan. ' : ''}Showing ${matches.length} live ${matches.length === 1 ? 'fixture' : 'fixtures'}. Data is refreshed about once a minute.`
      : 'No live fixtures were returned. The table will check again in one minute.';
  } catch (error) {
    statusText.textContent = 'Connection problem — keeping last scan';
    notice.textContent = `Live refresh failed: ${error.message}. Showing the last successful scan where available; pressure is not reset to zero.`;
    if (currentMatches.length) renderMatches(currentMatches, true);
    else if (!body.children.length || body.querySelector('.empty-state')) renderEmpty('Unable to load games', error.message);
  } finally {
    refreshing = false;
  }
}

function cacheFixtures(matches) {
  const now = Date.now();
  matches.forEach((item) => {
    const key = fixtureKey(item);
    lastLiveFixtures.set(key, { item, seenAt: now });
  });
}

function getRecentlyMissingFixtures() {
  const cutoff = Date.now() - FIXTURE_CACHE_TTL_MS;
  return [...lastLiveFixtures.values()]
    .filter((entry) => entry?.seenAt >= cutoff && entry.item?.fixture)
    .map((entry) => ({ ...entry.item, _temporarilyCached: true }));
}

function fixtureKey(item) {
  const fixture = item?.fixture?.fixture || {};
  const teams = item?.fixture?.teams || {};
  return String(fixture.id || `${teams.home?.id ?? 'home'}-${teams.away?.id ?? 'away'}-${fixture.date || 'fixture'}`);
}

function useLatestGoodStats(item) {
  const key = fixtureKey(item);
  const currentStats = Array.isArray(item.stats) ? item.stats : [];
  const isFresh = currentStats.length > 0 && !item.statsError;
  if (isFresh) {
    lastGoodStats.set(key, { stats: currentStats, savedAt: Date.now() });
    return { ...item, stats: currentStats, statsStatus: 'current' };
  }

  const cached = lastGoodStats.get(key);
  if (cached?.stats?.length) {
    return {
      ...item,
      stats: cached.stats,
      statsStatus: 'cached',
      statsError: item.statsError || 'No statistics in the latest response; using the last successful statistics.'
    };
  }
  return { ...item, stats: currentStats, statsStatus: 'unavailable' };
}

function numberValue(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value.replace('%', '').replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function getStat(team, names) {
  const values = team?.statistics || [];
  const found = values.find((item) => names.includes(item.type));
  return found ? numberValue(found.value) : null;
}

function getTeamEvents(teamId, events, predicate) {
  return (Array.isArray(events) ? events : []).filter((event) => String(event.team?.id) === String(teamId) && predicate(event));
}

function orderedStats(item) {
  const stats = Array.isArray(item?.stats) ? item.stats : [];
  const teams = item?.fixture?.teams || {};
  const find = (id, fallback) => stats.find((entry) => String(entry?.team?.id) === String(id)) || stats[fallback];
  return [find(teams.home?.id, 0), find(teams.away?.id, 1)];
}

function statsSnapshot(teamStats) {
  return Object.fromEntries(Object.entries(statAliases).map(([key, aliases]) => [key, getStat(teamStats, aliases)]));
}

function cumulativePressure(teamStats, minute) {
  if (!teamStats) return null;
  const scale = Math.max(12, minute);
  const parts = [[getStat(teamStats, statAliases.shots), 7, 0.27], [getStat(teamStats, statAliases.onTarget), 3, 0.34], [getStat(teamStats, statAliases.corners), 5, 0.18], [getStat(teamStats, statAliases.dangerous), 24, 0.15]];
  let weighted = 0;
  let availableWeight = 0;
  for (const [value, expected, weight] of parts) {
    if (value === null) continue;
    weighted += Math.min(1, (value * 90 / scale) / expected) * weight;
    availableWeight += weight;
  }
  const possession = getStat(teamStats, statAliases.possession);
  if (possession !== null) {
    weighted += Math.min(1, Math.max(0, possession - 45) / 30) * 0.06;
    availableWeight += 0.06;
  }
  return availableWeight ? Math.round(Math.max(0, Math.min(100, weighted / availableWeight * 100))) : null;
}

function rollingPressure(current, baseline, teamStats, durationMinutes, minute) {
  // Before a full 12-minute baseline exists, use the existing match-to-date heuristic.
  if (!baseline || durationMinutes < 11.5) return cumulativePressure(teamStats, minute);
  const parts = [
    ['shots', 2, 0.27],
    ['onTarget', 1, 0.34],
    ['corners', 1, 0.18],
    ['dangerous', 6, 0.15]
  ];
  let weighted = 0;
  let availableWeight = 0;
  for (const [key, expected, weight] of parts) {
    const nowValue = current?.[key];
    const thenValue = baseline?.[key];
    if (!Number.isFinite(nowValue)) continue;
    const difference = Number.isFinite(thenValue) ? Math.max(0, nowValue - thenValue) : nowValue;
    weighted += Math.min(1, difference / expected) * weight;
    availableWeight += weight;
  }
  const possession = current?.possession;
  if (Number.isFinite(possession)) {
    weighted += Math.min(1, Math.max(0, possession - 45) / 30) * 0.06;
    availableWeight += 0.06;
  }
  return availableWeight ? Math.round(Math.max(0, Math.min(100, weighted / availableWeight * 100))) : null;
}

function updatePressureHistory(item) {
  const [homeStats, awayStats] = orderedStats(item);
  if (!homeStats && !awayStats) return;
  const key = fixtureKey(item);
  const history = pressureHistory.get(key) || [];
  const minute = Number(item?.fixture?.fixture?.status?.elapsed) || 0;
  const now = Date.now();
  const prior = history[history.length - 1];
  const sample = {
    timestamp: now,
    minute,
    homeStats: homeStats ? statsSnapshot(homeStats) : prior?.homeStats || null,
    awayStats: awayStats ? statsSnapshot(awayStats) : prior?.awayStats || null,
    home: null,
    away: null
  };

  const cutoff = now - PRESSURE_WINDOW_MINUTES * 60_000;
  const baseline = [...history].reverse().find((point) => point.timestamp <= cutoff || minute - point.minute >= PRESSURE_WINDOW_MINUTES);
  const actualDuration = baseline
    ? Math.max(0, Math.min(PRESSURE_WINDOW_MINUTES, (now - baseline.timestamp) / 60_000 || minute - baseline.minute))
    : Math.min(PRESSURE_WINDOW_MINUTES, minute);

  sample.home = rollingPressure(sample.homeStats, baseline?.homeStats, homeStats, actualDuration, minute);
  sample.away = rollingPressure(sample.awayStats, baseline?.awayStats, awayStats, actualDuration, minute);
  if (sample.home === null && prior) sample.home = prior.home;
  if (sample.away === null && prior) sample.away = prior.away;

  // Replace same-minute retries; otherwise preserve every scan as a full-match timeline point.
  if (prior && prior.minute === minute && now - prior.timestamp < 50_000) history[history.length - 1] = sample;
  else history.push(sample);
  while (history.length > HISTORY_LIMIT) history.shift();
  pressureHistory.set(key, history);
}

function latestPressure(item) {
  const history = pressureHistory.get(fixtureKey(item)) || [];
  const point = history[history.length - 1];
  if (point) return { home: point.home, away: point.away };
  const [homeStats, awayStats] = orderedStats(item);
  const minute = Number(item?.fixture?.fixture?.status?.elapsed) || 0;
  return { home: cumulativePressure(homeStats, minute), away: cumulativePressure(awayStats, minute) };
}

function pressureFor(item) {
  const scores = latestPressure(item);
  const teams = item?.fixture?.teams || {};
  const sides = [
    { name: teams.home?.name || 'Home', score: scores.home },
    { name: teams.away?.name || 'Away', score: scores.away }
  ];
  const available = sides.filter((side) => Number.isFinite(side.score));
  available.sort((a, b) => b.score - a.score);
  return { sides, score: available[0]?.score ?? null };
}

function buildPressureTrend(item) {
  const history = pressureHistory.get(fixtureKey(item)) || [];
  const homeName = item?.fixture?.teams?.home?.name || 'Home';
  const awayName = item?.fixture?.teams?.away?.name || 'Away';
  const currentMinute = Number(item?.fixture?.fixture?.status?.elapsed) || 0;
  const maxMinute = Math.max(90, currentMinute, ...history.map((point) => point.minute || 0));
  const width = 360;
  const height = 190;
  const left = 36;
  const right = 10;
  const top = 12;
  const bottom = 28;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const xFor = (minute) => left + Math.max(0, Math.min(maxMinute, minute)) / maxMinute * plotWidth;
  const yFor = (score) => top + (100 - score) / 100 * plotHeight;
  const pathFor = (side) => history.filter((point) => Number.isFinite(point[side]))
    .map((point, index) => `${index ? 'L' : 'M'} ${xFor(point.minute)} ${yFor(point[side])}`).join(' ');
  const grid = [0, 25, 50, 75, 100].map((score) => `<line class="chart-grid" x1="${left}" y1="${yFor(score)}" x2="${width - right}" y2="${yFor(score)}"/><text class="chart-axis" x="${left - 7}" y="${yFor(score) + 4}" text-anchor="end">${score}</text>`).join('');
  const timeTicks = [0, 15, 30, 45, 60, 75, 90].filter((minute) => minute <= maxMinute).map((minute) => `<text class="chart-time" x="${xFor(minute)}" y="${height - 7}" text-anchor="middle">${minute}'</text>`).join('');
  const dots = history.map((point) => `<circle class="trend-point home" cx="${xFor(point.minute)}" cy="${yFor(point.home ?? 0)}" r="2.5"><title>${escapeHtml(homeName)} ${Number.isFinite(point.home) ? point.home : 'unavailable'} at ${point.minute}'</title></circle><circle class="trend-point away" cx="${xFor(point.minute)}" cy="${yFor(point.away ?? 0)}" r="2.5"><title>${escapeHtml(awayName)} ${Number.isFinite(point.away) ? point.away : 'unavailable'} at ${point.minute}'</title></circle>`).join('');
  return `<section class="pressure-trend" aria-label="Full-match pressure trend">
    <div class="trend-heading"><strong>Pressure trend</strong><span>Full match · 12-minute rolling pressure</span></div>
    <div class="trend-legend"><span><i class="swatch home"></i>${escapeHtml(homeName)}</span><span><i class="swatch away"></i>${escapeHtml(awayName)}</span></div>
    <svg class="pressure-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(homeName)} and ${escapeHtml(awayName)} 12-minute rolling pressure from kickoff to now">
      ${grid}<path class="trend-line home" d="${pathFor('home')}"/><path class="trend-line away" d="${pathFor('away')}"/>${dots}${timeTicks}
    </svg>
    ${history.length < 2 ? '<p class="trend-empty">Full-match trend builds from the first successful scan on this device.</p>' : ''}
  </section>`;
}

function pressureClass(score) {
  if (!Number.isFinite(score)) return 'unknown';
  if (score >= 70) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
}

function formatGoalEvent(event) {
  const elapsed = Number(event.time?.elapsed);
  const extra = event.time?.extra ? `+${event.time.extra}` : '';
  const minute = Number.isFinite(elapsed) ? `${elapsed}${extra}'` : '—';
  const player = event.player?.name || 'Goal';
  const suffix = /own goal/i.test(event.detail || '') ? ' (OG)' : /penalty/i.test(event.detail || '') ? ' (pen)' : '';
  return `${minute} ${player}${suffix}`;
}

function teamGoalMarkup(teamId, events) {
  const goals = getTeamEvents(teamId, events, (event) => event.type === 'Goal' || /goal/i.test(event.type || '')).slice(0, 3);
  if (!goals.length) return '';
  return `<div class="goal-events">${goals.map((goal) => `<span>⚽ ${escapeHtml(formatGoalEvent(goal))}</span>`).join('')}</div>`;
}

function teamCardMarkup(teamId, events) {
  const yellowCards = getTeamEvents(teamId, events, (event) => /card/i.test(`${event.type || ''} ${event.detail || ''}`) && /yellow/i.test(`${event.type || ''} ${event.detail || ''}`)).length;
  const redCards = getTeamEvents(teamId, events, (event) => /card/i.test(`${event.type || ''} ${event.detail || ''}`) && /red/i.test(`${event.type || ''} ${event.detail || ''}`)).length;
  return `<span class="team-card-badges" aria-label="${yellowCards} yellow cards and ${redCards} red cards"><span class="team-card-pill yellow">${yellowCards}</span><span class="team-card-pill red">${redCards}</span></span>`;
}

function renderMatches(items, staleRefresh = false) {
  if (!items.length) {
    renderEmpty('No live games right now', 'Live fixtures will appear here as soon as matches are underway.');
    return;
  }
  body.innerHTML = items.map((item, index) => {
    const { fixture, stats = [], statsError, events = [] } = item;
    const match = fixture.fixture;
    const teams = fixture.teams;
    const goals = fixture.goals;
    const pressure = pressureFor(item);
    const top = pressure.sides.filter((side) => Number.isFinite(side.score)).sort((a, b) => b.score - a.score)[0];
    const second = pressure.sides.filter((side) => Number.isFinite(side.score)).sort((a, b) => b.score - a.score)[1];
    const score = pressure.score;
    const cls = pressureClass(score);
    const time = match.status?.elapsed === null || match.status?.elapsed === undefined ? match.status?.short || 'LIVE' : `${match.status.elapsed}'`;
    const signals = stats.length ? signalText(stats) : 'Statistics temporarily unavailable';
    const logo = (team) => team.logo ? `<img class="team-logo" src="${escapeHtml(team.logo)}" alt="" loading="lazy">` : '<span class="team-logo fallback">●</span>';
    const cacheNote = item._temporarilyCached ? 'Fixture list temporarily unavailable; retaining last scan.' : item.statsStatus === 'cached' ? 'Using last successful statistics; latest fetch unavailable.' : '';
    const coverageNote = cacheNote || (statsError ? 'Statistics unavailable; pressure retained where possible.' : (!stats.length ? 'Waiting for statistics' : ''));
    const pressureText = Number.isFinite(score) ? score : '—';
    const meterWidth = Number.isFinite(score) ? score : 0;
    return `<tr>
      <td class="rank-col rank">${String(index + 1).padStart(2, '0')}</td>
      <td><div class="match-cell"><div class="teams"><div class="team-line">${logo(teams.home)}<span>${escapeHtml(teams.home.name)}</span><b>${goals.home ?? '–'}</b>${teamCardMarkup(teams.home.id, events)}</div>${teamGoalMarkup(teams.home.id, events)}<div class="team-line">${logo(teams.away)}<span>${escapeHtml(teams.away.name)}</span><b>${goals.away ?? '–'}</b>${teamCardMarkup(teams.away.id, events)}</div>${teamGoalMarkup(teams.away.id, events)}</div><div class="competition">${escapeHtml(fixture.league?.name || '')} <span>·</span> ${escapeHtml(fixture.league?.country || '')}</div></div></td>
      <td class="center minute">${escapeHtml(String(time))}</td>
      <td class="center score-cell">${goals.home ?? '–'} <span>:</span> ${goals.away ?? '–'}</td>
      <td><div class="pressure-cell"><div class="pressure-top"><strong class="${cls}-text">${pressureText}</strong><span class="meter"><i class="${cls}" style="width:${meterWidth}%"></i></span><span class="level ${cls}">${!Number.isFinite(score) ? 'NO DATA' : cls === 'high' ? 'HIGH' : cls === 'medium' ? 'BUILDING' : 'LOW'}</span></div>${buildPressureTrend(item)}<div class="pressure-team">${escapeHtml(top?.name || 'Pressure unavailable')}<span>${Number.isFinite(second?.score) ? `${second.score} away` : 'away unavailable'}</span></div>${coverageNote ? `<small class="coverage-note">${escapeHtml(coverageNote)}</small>` : ''}</div></td>
      <td class="right signals">${escapeHtml(signals)}</td>
    </tr>`;
  }).join('');
  if (staleRefresh) statusText.textContent = 'Showing last successful scan';
}

function signalText(stats) {
  const values = stats.map((team) => ({ shots: getStat(team, statAliases.shots), onTarget: getStat(team, statAliases.onTarget), corners: getStat(team, statAliases.corners) }));
  const leader = values.sort((a, b) => ((b.onTarget || 0) * 3 + (b.shots || 0) + (b.corners || 0) * 2) - ((a.onTarget || 0) * 3 + (a.shots || 0) + (a.corners || 0) * 2))[0];
  if (!leader || [leader.shots, leader.onTarget, leader.corners].every((value) => value === null)) return 'Limited data';
  return `${leader.onTarget ?? 0} on target · ${leader.shots ?? 0} shots · ${leader.corners ?? 0} corners`;
}

function renderEmpty(title, description) {
  body.innerHTML = `<tr><td colspan="6" class="empty-state"><span class="empty-icon">⌁</span><strong>${escapeHtml(title)}</strong><span>${escapeHtml(description)}</span></td></tr>`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

runRefresh();
refreshTimer = window.setInterval(runRefresh, REFRESH_MS);
window.addEventListener('beforeunload', () => window.clearInterval(refreshTimer));
