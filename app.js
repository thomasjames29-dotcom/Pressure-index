const REFRESH_MS = 60_000;
const PRESSURE_HISTORY_MAX_MINUTES = 15;
const PRESSURE_WINDOW_OPTIONS = [10, 12, 15];
const HISTORY_STORAGE_KEY = 'pressure-index-history-v1';
const WINDOW_STORAGE_KEY = 'pressure-index-window-v1';
const pressureHistory = loadPressureHistory();
let currentMatches = [];
let selectedPressureWindowMinutes = loadPressureWindow();
const $ = (selector) => document.querySelector(selector);
const body = $('#matchesBody');
const notice = $('#notice');
const statusText = $('#statusText');
const updatedAt = $('#updatedAt');
let refreshTimer;
let refreshing = false;

const statAliases = {
  shots: ['Total Shots', 'Shots'],
  onTarget: ['Shots on Goal', 'Shots on Target'],
  corners: ['Corner Kicks', 'Corners'],
  dangerous: ['Dangerous Attacks'],
  possession: ['Ball Possession']
};

function loadPressureHistory() {
  try {
    const stored = JSON.parse(localStorage.getItem(HISTORY_STORAGE_KEY) || '{}');
    return new Map(Object.entries(stored).map(([key, entries]) => [key, Array.isArray(entries) ? entries : []]));
  } catch {
    return new Map();
  }
}

function savePressureHistory() {
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(Object.fromEntries(pressureHistory)));
  } catch {
    // The chart still works for the current page if browser storage is unavailable.
  }
}

function loadPressureWindow() {
  const stored = Number(localStorage.getItem(WINDOW_STORAGE_KEY));
  return PRESSURE_WINDOW_OPTIONS.includes(stored) ? stored : 12;
}

function setPressureWindowMinutes(minutes) {
  if (!PRESSURE_WINDOW_OPTIONS.includes(minutes)) return;
  selectedPressureWindowMinutes = minutes;
  try {
    localStorage.setItem(WINDOW_STORAGE_KEY, String(minutes));
  } catch {
    // Keep the selected value for this page session.
  }
  renderMatches(currentMatches);
}

async function runRefresh() {
  if (refreshing) return;
  refreshing = true;
  statusText.textContent = 'Updating live games…';
  try {
    const response = await fetch('/api/live', { headers: { Accept: 'application/json' } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Service returned ${response.status}`);
    const matches = Array.isArray(payload.matches) ? payload.matches : [];
    matches.sort((a, b) => pressureFor(b).score - pressureFor(a).score);
    currentMatches = matches;
    matches.forEach(updatePressureHistory);
    savePressureHistory();
    renderMatches(matches);

    const now = new Date();
    statusText.textContent = 'Live data connected';
    updatedAt.textContent = `Updated ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    $('#matchCount').textContent = String(matches.length);
    notice.textContent = matches.length
      ? `Showing ${matches.length} live ${matches.length === 1 ? 'fixture' : 'fixtures'}. Data is refreshed about once a minute.`
      : 'No live fixtures were returned right now. The table will check again in one minute.';
  } catch (error) {
    statusText.textContent = 'Connection problem';
    notice.textContent = `Could not load live data: ${error.message}. The service may be starting up, or its API key may need to be configured by the site owner.`;
    if (!body.children.length || body.querySelector('.empty-state')) renderEmpty('Unable to load games', error.message);
  } finally {
    refreshing = false;
  }
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

function teamPressureScore(teamStats, minute) {
  const shots = getStat(teamStats, statAliases.shots);
  const onTarget = getStat(teamStats, statAliases.onTarget);
  const corners = getStat(teamStats, statAliases.corners);
  const dangerous = getStat(teamStats, statAliases.dangerous);
  const possession = getStat(teamStats, statAliases.possession);
  const scale = Math.max(12, minute);
  const parts = [[shots, 7, 0.27], [onTarget, 3, 0.34], [corners, 5, 0.18], [dangerous, 24, 0.15]];
  let weighted = 0;
  let availableWeight = 0;
  for (const [value, expected, weight] of parts) {
    if (value === null) continue;
    weighted += Math.min(1, (value * 90 / scale) / expected) * weight;
    availableWeight += weight;
  }
  if (possession !== null) {
    weighted += Math.min(1, Math.max(0, possession - 45) / 30) * 0.06;
    availableWeight += 0.06;
  }
  return Math.round(Math.max(0, Math.min(100, availableWeight ? weighted / availableWeight * 100 : 0)));
}

function pressureHistoryKey(item) {
  const match = item?.fixture?.fixture || {};
  const teams = item?.fixture?.teams || {};
  return String(match.id || `${teams.home?.id ?? 'home'}-${teams.away?.id ?? 'away'}-${match.date || 'fixture'}`);
}

function orderedTeamStats(item) {
  const stats = Array.isArray(item?.stats) ? item.stats : [];
  const homeId = item?.fixture?.teams?.home?.id;
  const awayId = item?.fixture?.teams?.away?.id;
  const forTeam = (id, fallbackIndex) => stats.find((entry) => String(entry?.team?.id) === String(id)) || stats[fallbackIndex];
  return [forTeam(homeId, 0), forTeam(awayId, 1)];
}

function updatePressureHistory(item) {
  const [homeStats, awayStats] = orderedTeamStats(item);
  if (!homeStats && !awayStats) return;
  const minute = Number(item?.fixture?.fixture?.status?.elapsed) || 0;
  const now = Date.now();
  const key = pressureHistoryKey(item);
  const history = pressureHistory.get(key) || [];
  const sample = {
    timestamp: now,
    minute,
    home: homeStats ? teamPressureScore(homeStats, minute) : null,
    away: awayStats ? teamPressureScore(awayStats, minute) : null
  };
  const cutoff = now - PRESSURE_HISTORY_MAX_MINUTES * 60 * 1000;
  const retained = history.filter((entry) => entry.timestamp >= cutoff);
  const last = retained[retained.length - 1];
  // Avoid adding multiple identical samples when a refresh is manually retried quickly.
  if (last && now - last.timestamp < 5_000) retained[retained.length - 1] = sample;
  else retained.push(sample);
  pressureHistory.set(key, retained);
}

function buildPressureTrend(item) {
  const key = pressureHistoryKey(item);
  const cutoff = Date.now() - selectedPressureWindowMinutes * 60 * 1000;
  const points = (pressureHistory.get(key) || []).filter((entry) => entry.timestamp >= cutoff);
  const homeName = item?.fixture?.teams?.home?.name || 'Home';
  const awayName = item?.fixture?.teams?.away?.name || 'Away';
  const width = 300;
  const height = 136;
  const left = 28;
  const right = 8;
  const top = 8;
  const bottom = 22;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const yFor = (score) => top + (100 - score) / 100 * plotHeight;
  const xFor = (entry) => {
    const span = selectedPressureWindowMinutes * 60 * 1000;
    return left + Math.max(0, Math.min(1, (entry.timestamp - cutoff) / span)) * plotWidth;
  };
  const makePath = (side) => {
    const available = points.filter((entry) => Number.isFinite(entry[side]));
    if (!available.length) return '';
    if (available.length === 1) {
      const x = xFor(available[0]);
      const y = yFor(available[0][side]);
      return `M ${x - 0.1} ${y} L ${x + 0.1} ${y}`;
    }
    return available.map((entry, index) => `${index ? 'L' : 'M'} ${xFor(entry)} ${yFor(entry[side])}`).join(' ');
  };
  const homePath = makePath('home');
  const awayPath = makePath('away');
  const dots = points.map((entry) => {
    const x = xFor(entry);
    const time = new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return [
      Number.isFinite(entry.home) ? `<circle class="trend-point home" cx="${x}" cy="${yFor(entry.home)}" r="3.5"><title>${escapeHtml(homeName)}: ${entry.home} at ${time}</title></circle>` : '',
      Number.isFinite(entry.away) ? `<circle class="trend-point away" cx="${x}" cy="${yFor(entry.away)}" r="3.5"><title>${escapeHtml(awayName)}: ${entry.away} at ${time}</title></circle>` : ''
    ].join('');
  }).join('');
  const hasData = points.length > 0;

  return `<section class="pressure-trend" aria-label="Team pressure trend over ${selectedPressureWindowMinutes} minutes">
    <div class="trend-heading"><strong>Pressure trend</strong><span>Last ${selectedPressureWindowMinutes} minutes</span></div>
    <div class="chart-window-controls" role="group" aria-label="Chart time window">
      ${PRESSURE_WINDOW_OPTIONS.map((minutes) => `<button type="button" class="chart-window-button ${minutes === selectedPressureWindowMinutes ? 'active' : ''}" data-window-minutes="${minutes}" aria-pressed="${minutes === selectedPressureWindowMinutes}">${minutes} min</button>`).join('')}
    </div>
    <div class="trend-legend"><span><i class="swatch home"></i>${escapeHtml(homeName)}</span><span><i class="swatch away"></i>${escapeHtml(awayName)}</span></div>
    ${hasData ? `<svg class="pressure-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(homeName)} and ${escapeHtml(awayName)} pressure scores from 0 to 100 over the last ${selectedPressureWindowMinutes} minutes">
      <line class="chart-grid" x1="${left}" y1="${yFor(100)}" x2="${width - right}" y2="${yFor(100)}"/><line class="chart-grid" x1="${left}" y1="${yFor(50)}" x2="${width - right}" y2="${yFor(50)}"/><line class="chart-grid" x1="${left}" y1="${yFor(0)}" x2="${width - right}" y2="${yFor(0)}"/>
      <text class="chart-axis" x="1" y="${yFor(100) + 3}">100</text><text class="chart-axis" x="7" y="${yFor(50) + 3}">50</text><text class="chart-axis" x="13" y="${yFor(0) + 3}">0</text>
      <path class="trend-line home" d="${homePath}"/><path class="trend-line away" d="${awayPath}"/>${dots}
      <text class="chart-time" x="${left}" y="${height - 4}">-${selectedPressureWindowMinutes}m</text><text class="chart-time" x="${width - right}" y="${height - 4}" text-anchor="end">Now</text>
    </svg>` : '<p class="trend-empty">Waiting for team statistics to build the trend.</p>'}
  </section>`;
}

function pressureFor({ fixture, stats = [] }) {
  const minute = Number(fixture.fixture?.status?.elapsed) || 0;
  const teams = fixture.teams || {};
  const homeId = teams.home?.id;
  const awayId = teams.away?.id;
  const homeStats = stats.find((entry) => String(entry?.team?.id) === String(homeId)) || stats[0];
  const awayStats = stats.find((entry) => String(entry?.team?.id) === String(awayId)) || stats[1];
  const sides = [
    { name: teams.home?.name || homeStats?.team?.name || 'Home', score: teamPressureScore(homeStats, minute) },
    { name: teams.away?.name || awayStats?.team?.name || 'Away', score: teamPressureScore(awayStats, minute) }
  ];
  sides.sort((a, b) => b.score - a.score);
  return { sides, score: sides[0]?.score || 0 };
}

function pressureClass(score) {
  if (score >= 70) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
}

function formatGoalEvent(event) {
  const elapsed = Number(event.time?.elapsed);
  const extra = event.time?.extra ? `+${event.time.extra}` : '';
  const minute = Number.isFinite(elapsed) ? `${elapsed}${extra}'` : '—';
  const player = event.player?.name || 'Goal';
  const text = event.detail || '';
  const suffix = /own goal/i.test(text) ? ' (OG)' : /penalty/i.test(text) ? ' (pen)' : '';
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

function renderMatches(items) {
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
    const top = pressure.sides[0];
    const second = pressure.sides[1];
    const cls = pressureClass(pressure.score);
    const time = match.status?.elapsed === null || match.status?.elapsed === undefined ? match.status?.short || 'LIVE' : `${match.status.elapsed}'`;
    const signals = stats.length ? signalText(stats) : 'Stats pending';
    const logo = (team) => team.logo ? `<img class="team-logo" src="${escapeHtml(team.logo)}" alt="" loading="lazy">` : '<span class="team-logo fallback">●</span>';
    const coverageNote = statsError ? 'Statistics unavailable' : (!stats.length ? 'Waiting for statistics' : '');
    return `<tr>
      <td class="rank-col rank">${String(index + 1).padStart(2, '0')}</td>
      <td><div class="match-cell"><div class="teams"><div class="team-line">${logo(teams.home)}<span>${escapeHtml(teams.home.name)}</span><b>${goals.home ?? '–'}</b>${teamCardMarkup(teams.home.id, events)}</div>${teamGoalMarkup(teams.home.id, events)}<div class="team-line">${logo(teams.away)}<span>${escapeHtml(teams.away.name)}</span><b>${goals.away ?? '–'}</b>${teamCardMarkup(teams.away.id, events)}</div>${teamGoalMarkup(teams.away.id, events)}</div><div class="competition">${escapeHtml(fixture.league?.name || '')} <span>·</span> ${escapeHtml(fixture.league?.country || '')}</div></div></td>
      <td class="center minute">${escapeHtml(String(time))}</td>
      <td class="center score-cell">${goals.home ?? '–'} <span>:</span> ${goals.away ?? '–'}</td>
      <td><div class="pressure-cell"><div class="pressure-top"><strong class="${cls}-text">${pressure.score}</strong><span class="meter"><i class="${cls}" style="width:${pressure.score}%"></i></span><span class="level ${cls}">${cls === 'high' ? 'HIGH' : cls === 'medium' ? 'BUILDING' : 'LOW'}</span></div>${buildPressureTrend(item)}<div class="pressure-team">${escapeHtml(top?.name || 'No data')}<span>${second?.score ?? 0} away</span></div>${coverageNote ? `<small class="coverage-note">${escapeHtml(coverageNote)}</small>` : ''}</div></td>
      <td class="right signals">${escapeHtml(signals)}</td>
    </tr>`;
  }).join('');
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

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-window-minutes]');
  if (button) setPressureWindowMinutes(Number(button.dataset.windowMinutes));
});

runRefresh();
refreshTimer = window.setInterval(runRefresh, REFRESH_MS);
window.addEventListener('beforeunload', () => window.clearInterval(refreshTimer));
