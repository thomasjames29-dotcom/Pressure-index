const REFRESH_MS = 60_000;
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
  return (Array.isArray(events) ? events : []).filter((event) => {
    const sameTeam = String(event.team?.id) === String(teamId);
    return sameTeam && predicate(event);
  });
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
    const score = Math.round(Math.max(0, Math.min(100, availableWeight ? weighted / availableWeight * 100 : 0)));
    return { name: teamStats?.team?.name || (index === 0 ? 'Home' : 'Away'), score };
  });
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
  const yellowCards = getTeamEvents(teamId, events, (event) => {
    const text = `${event.type || ''} ${event.detail || ''}`;
    return /card/i.test(text) && /yellow/i.test(text);
  }).length;
  const redCards = getTeamEvents(teamId, events, (event) => {
    const text = `${event.type || ''} ${event.detail || ''}`;
    return /card/i.test(text) && /red/i.test(text);
  }).length;
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
      <td><div class="pressure-cell"><div class="pressure-top"><strong class="${cls}-text">${pressure.score}</strong><span class="meter"><i class="${cls}" style="width:${pressure.score}%"></i></span><span class="level ${cls}">${cls === 'high' ? 'HIGH' : cls === 'medium' ? 'BUILDING' : 'LOW'}</span></div><div class="pressure-team">${escapeHtml(top?.name || 'No data')}<span>${second?.score ?? 0} away</span></div>${coverageNote ? `<small class="coverage-note">${escapeHtml(coverageNote)}</small>` : ''}</div></td>
      <td class="right signals">${escapeHtml(signals)}</td>
    </tr>`;
  }).join('');
}

function signalText(stats) {
  const values = stats.map((team) => ({
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

runRefresh();
refreshTimer = window.setInterval(runRefresh, REFRESH_MS);
window.addEventListener('beforeunload', () => window.clearInterval(refreshTimer));
