const API_BASE = 'https://v3.football.api-sports.io';
const REFRESH_MS = 60_000;
const $ = (selector) => document.querySelector(selector);
const form = $('#keyForm');
const keyInput = $('#apiKey');
const body = $('#matchesBody');
const notice = $('#notice');
const statusText = $('#statusText');
const updatedAt = $('#updatedAt');
const connectButton = $('#connectButton');
const disconnectButton = $('#disconnectButton');
let apiKey = '';
let refreshTimer;
let refreshing = false;

const statAliases = {
  shots: ['Total Shots', 'Shots'],
  onTarget: ['Shots on Goal', 'Shots on Target'],
  corners: ['Corner Kicks', 'Corners'],
  dangerous: ['Dangerous Attacks'],
  possession: ['Ball Possession']
};

form.addEventListener('submit', (event) => {
  event.preventDefault();
  apiKey = keyInput.value.trim();
  if (!apiKey) return;
  keyInput.value = '';
  keyInput.placeholder = 'Connected (key not retained)';
  connectButton.hidden = true;
  disconnectButton.hidden = false;
  runRefresh();
  refreshTimer = window.setInterval(runRefresh, REFRESH_MS);
});

disconnectButton.addEventListener('click', () => {
  window.clearInterval(refreshTimer);
  apiKey = '';
  connectButton.hidden = false;
  disconnectButton.hidden = true;
  statusText.textContent = 'Not connected';
  updatedAt.textContent = 'Disconnected';
  $('#matchCount').textContent = '—';
  renderEmpty('Disconnected', 'Enter your API key to load live fixtures.');
  notice.textContent = 'Disconnected. Your API key was held only in memory and has been cleared.';
});

async function apiGet(path) {
  const response = await fetch(`${API_BASE}${path}`, { headers: { 'x-apisports-key': apiKey } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || (payload.errors && Object.keys(payload.errors).length)) {
    const detail = payload.errors ? Object.values(payload.errors).join(' · ') : `${response.status} ${response.statusText}`;
    throw new Error(detail || 'API request failed');
  }
  return payload.response || [];
}

async function runRefresh() {
  if (!apiKey || refreshing) return;
  refreshing = true;
  statusText.textContent = 'Updating live games…';
  notice.textContent = 'Fetching live fixtures and available statistics.';
  try {
    const fixtures = await apiGet('/fixtures?live=all');
    const enriched = await Promise.all(fixtures.map(async (fixture) => {
      try {
        const stats = await apiGet(`/fixtures/statistics?fixture=${encodeURIComponent(fixture.fixture.id)}`);
        return { fixture, stats };
      } catch (error) {
        return { fixture, stats: [], statsError: error.message };
      }
    }));
    enriched.sort((a, b) => pressureFor(b).score - pressureFor(a).score);
    renderMatches(enriched);
    const now = new Date();
    statusText.textContent = 'Live data connected';
    updatedAt.textContent = `Updated ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    notice.textContent = fixtures.length
      ? `Showing ${fixtures.length} live ${fixtures.length === 1 ? 'fixture' : 'fixtures'}. Match statistics refresh every minute; API request usage depends on the number of live games.`
      : 'No live fixtures were returned right now. The table will check again in one minute.';
    $('#matchCount').textContent = String(fixtures.length);
  } catch (error) {
    statusText.textContent = 'Connection problem';
    notice.textContent = `Could not load live data: ${error.message}. Check that the key is valid, your plan allows these endpoints, and the API permits browser requests from this site.`;
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

function pressureFor({ fixture, stats }) {
  const minute = Number(fixture.fixture?.status?.elapsed) || 0;
  const sides = [0, 1].map((index) => {
    const teamStats = stats[index];
    const shots = getStat(teamStats, statAliases.shots);
    const onTarget = getStat(teamStats, statAliases.onTarget);
    const corners = getStat(teamStats, statAliases.corners);
    const dangerous = getStat(teamStats, statAliases.dangerous);
    const possession = getStat(teamStats, statAliases.possession);
    // Per-minute rates soften the late-game advantage of cumulative totals.
    const scale = Math.max(12, minute);
    const parts = [
      [shots, 7, 0.27], [onTarget, 3, 0.34], [corners, 5, 0.18],
      [dangerous, 24, 0.15]
    ];
    let weighted = 0;
    let availableWeight = 0;
    for (const [value, expected, weight] of parts) {
      if (value === null) continue;
      const per90 = value * 90 / scale;
      weighted += Math.min(1, per90 / expected) * weight;
      availableWeight += weight;
    }
    if (possession !== null) {
      // Possession is intentionally a small contribution: possession alone is not pressure.
      weighted += Math.min(1, Math.max(0, possession - 45) / 30) * 0.06;
      availableWeight += 0.06;
    }
    const coverage = availableWeight / 1;
    const raw = availableWeight ? weighted / availableWeight : 0;
    const score = Math.round(Math.max(0, Math.min(100, raw * 100)));
    return { name: teamStats?.team?.name || (index === 0 ? 'Home' : 'Away'), score, coverage };
  });
  sides.sort((a, b) => b.score - a.score);
  return { sides, score: sides[0]?.score || 0, minute };
}

function pressureClass(score) {
  if (score >= 70) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
}

function renderMatches(items) {
  if (!items.length) {
    renderEmpty('No live games right now', 'Live fixtures will appear here as soon as matches are underway.');
    return;
  }
  body.innerHTML = items.map((item, index) => {
    const { fixture, stats, statsError } = item;
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
      <td><div class="match-cell"><div class="teams"><div class="team-line">${logo(teams.home)}<span>${escapeHtml(teams.home.name)}</span><b>${goals.home ?? '–'}</b></div><div class="team-line">${logo(teams.away)}<span>${escapeHtml(teams.away.name)}</span><b>${goals.away ?? '–'}</b></div></div><div class="competition">${escapeHtml(fixture.league?.name || '')} <span>·</span> ${escapeHtml(fixture.league?.country || '')}</div></div></td>
      <td class="center minute">${escapeHtml(String(time))}</td>
      <td class="center score-cell">${goals.home ?? '–'} <span>:</span> ${goals.away ?? '–'}</td>
      <td><div class="pressure-cell"><div class="pressure-top"><strong class="${cls}-text">${pressure.score}</strong><span class="meter"><i class="${cls}" style="width:${pressure.score}%"></i></span><span class="level ${cls}">${cls === 'high' ? 'HIGH' : cls === 'medium' ? 'BUILDING' : 'LOW'}</span></div><div class="pressure-team">${escapeHtml(top?.name || 'No data')}<span>${second?.score ?? 0} away</span></div>${coverageNote ? `<small class="coverage-note">${escapeHtml(coverageNote)}</small>` : ''}</div></td>
      <td class="right signals">${escapeHtml(signals)}</td>
    </tr>`;
  }).join('');
}

function signalText(stats) {
  const values = stats.map((team) => ({
    name: team.team?.name || '',
    shots: getStat(team, statAliases.shots),
    onTarget: getStat(team, statAliases.onTarget),
    corners: getStat(team, statAliases.corners)
  }));
  const leader = values.sort((a, b) => ((b.onTarget || 0) * 3 + (b.shots || 0) + (b.corners || 0) * 2) - ((a.onTarget || 0) * 3 + (a.shots || 0) + (a.corners || 0) * 2))[0];
  if (!leader || [leader.shots, leader.onTarget, leader.corners].every((v) => v === null)) return 'Limited data';
  return `${leader.onTarget ?? 0} on target · ${leader.shots ?? 0} shots · ${leader.corners ?? 0} corners`;
}

function renderEmpty(title, description) {
  body.innerHTML = `<tr><td colspan="6" class="empty-state"><span class="empty-icon">⌁</span><strong>${escapeHtml(title)}</strong><span>${escapeHtml(description)}</span></td></tr>`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
