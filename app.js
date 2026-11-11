const $ = (selector) => document.querySelector(selector);
const body = $('#matchesBody');
const notice = $('#notice');
const statusText = $('#statusText');
const updatedAt = $('#updatedAt');
const matchCount = $('#matchCount');
const likelySummary = $('#likelySummary');
const windowSummary = $('#windowSummary');
const tabButtons = [...document.querySelectorAll('[data-day]')];
const viewButtons = [...document.querySelectorAll('[data-view]')];
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/London';
const STATS_STORAGE_KEY = 'pressure-index-first-goal-stats';
const statsDaySelect = $('#statsDaySelect');
const statsSummary = $('#statsSummary');
const statsDayTotal = $('#statsDayTotal');
const stats7DaySummary = $('#stats7DaySummary');
const stats30DaySummary = $('#stats30DaySummary');
const saveStatsButton = $('#saveStatsButton');
const clearStatsButton = $('#clearStatsButton');
const STATS_FIELDS = {
  noGoals: $('#statsNoGoals'),
  min0To20: $('#stats0To20'),
  min21ToHalftime: $('#stats21ToHalftime'),
  min45To75: $('#stats45To75'),
  min76ToFinish: $('#stats76ToFinish')
};
let activeDay = 0;
let loading = false;

function addDays(value, amount) {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + amount));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}
function computeWindowLabel(day) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const map = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  const today = `${map.year}-${map.month}-${map.day}`;
  const startDate = addDays(Number(map.hour) >= 8 ? today : addDays(today, -1), day);
  return `${formatWindowDate(startDate)} – ${formatWindowDate(addDays(startDate, 1))}`;
}
function formatWindowDate(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Intl.DateTimeFormat([], { timeZone: timezone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric' }).format(new Date(Date.UTC(year, month - 1, day, 8)));
}
function getLocalDateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function formatStatsDate(dateString) {
  const date = new Date(`${dateString}T12:00:00`);
  return Number.isNaN(date.getTime()) ? dateString : date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}
function readStoredStats() {
  try {
    const value = JSON.parse(localStorage.getItem(STATS_STORAGE_KEY) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
function writeStoredStats(stats) {
  try {
    localStorage.setItem(STATS_STORAGE_KEY, JSON.stringify(stats));
    return true;
  } catch {
    if (statsSummary) statsSummary.textContent = 'Could not save stats. Check that browser storage is enabled.';
    return false;
  }
}
function getDefaultStats() { return { noGoals: 0, min0To20: 0, min21ToHalftime: 0, min45To75: 0, min76ToFinish: 0 }; }
function getStatsForDate(date) { return { ...getDefaultStats(), ...(readStoredStats()[date] || {}) }; }
function validCount(value) {
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
}
function totalGames(stats) { return Object.values(stats).reduce((sum, value) => sum + validCount(value), 0); }
function formatStatsSummary(stats) {
  return [`Goalless ${validCount(stats.noGoals)}`, `0–20 ${validCount(stats.min0To20)}`, `21–HT ${validCount(stats.min21ToHalftime)}`, `45–75 ${validCount(stats.min45To75)}`, `76–FT ${validCount(stats.min76ToFinish)}`].join(' · ');
}
function updateSelectedDaySummary(date, stats = getStatsForDate(date)) {
  statsDayTotal.textContent = `Selected day total: ${totalGames(stats)} games`;
  statsSummary.textContent = totalGames(stats) ? `${formatStatsDate(date)} — ${formatStatsSummary(stats)}` : `No stats recorded for ${formatStatsDate(date)} yet.`;
}
function recentStats(days) {
  const stored = readStoredStats();
  const today = getLocalDateKey();
  const firstDay = addDays(today, -(days - 1));
  const totals = getDefaultStats();
  let recordedDays = 0;
  Object.entries(stored).forEach(([date, counts]) => {
    if (date < firstDay || date > today || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    recordedDays += 1;
    Object.keys(totals).forEach((key) => { totals[key] += validCount(counts?.[key]); });
  });
  return { totals, recordedDays };
}
function renderRecentStats() {
  [[7, stats7DaySummary], [30, stats30DaySummary]].forEach(([days, element]) => {
    const { totals, recordedDays } = recentStats(days);
    element.textContent = recordedDays ? `${formatStatsSummary(totals)} · ${recordedDays} ${recordedDays === 1 ? 'day' : 'days'} recorded` : 'No data recorded in this range.';
  });
}
function populateStatsInputs(date) {
  if (!date) return;
  const stats = getStatsForDate(date);
  Object.entries(STATS_FIELDS).forEach(([key, input]) => { input.value = validCount(stats[key]); });
  updateSelectedDaySummary(date, stats);
}
function renderStatsOptions() {
  if (!statsDaySelect) return;
  const stored = readStoredStats();
  const today = getLocalDateKey();
  const dates = [...new Set([today, ...Object.keys(stored)])].filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort((a, b) => b.localeCompare(a));
  const previous = statsDaySelect.value;
  statsDaySelect.innerHTML = dates.map((date) => `<option value="${date}">${date === today ? 'Today — ' : ''}${formatStatsDate(date)}</option>`).join('');
  statsDaySelect.value = dates.includes(previous) ? previous : today;
  populateStatsInputs(statsDaySelect.value);
  renderRecentStats();
}
function saveSelectedDayStats() {
  const date = statsDaySelect.value || getLocalDateKey();
  const stats = Object.fromEntries(Object.entries(STATS_FIELDS).map(([key, input]) => [key, validCount(input.value)]));
  const stored = readStoredStats();
  stored[date] = stats;
  if (writeStoredStats(stored)) renderStatsOptions();
}
function clearSelectedDayStats() {
  const date = statsDaySelect.value || getLocalDateKey();
  const stored = readStoredStats();
  delete stored[date];
  if (writeStoredStats(stored)) renderStatsOptions();
}
function setActiveView(viewName) {
  document.querySelectorAll('.view-panel').forEach((panel) => {
    const selected = panel.id === `${viewName}View`;
    panel.classList.toggle('active', selected);
    panel.hidden = !selected;
  });
  viewButtons.forEach((button) => {
    const selected = button.dataset.view === viewName;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-selected', String(selected));
  });
  if (viewName === 'stats') renderStatsOptions();
}
function setActiveTab() {
  tabButtons.forEach((button) => {
    const selected = Number(button.dataset.day) === activeDay;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-selected', String(selected));
  });
}
async function loadFixtures(day = activeDay) {
  if (loading) return;
  loading = true;
  activeDay = day;
  setActiveTab();
  statusText.textContent = 'Updating fixture analysis…';
  try {
    const response = await fetch(`/api/fixtures?day=${day}&timezone=${encodeURIComponent(timezone)}`, { headers: { Accept: 'application/json' } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Service returned ${response.status}`);
    const fixtures = Array.isArray(payload.fixtures) ? payload.fixtures : [];
    fixtures.sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
    renderFixtures(fixtures);
    matchCount.textContent = String(fixtures.length);
    likelySummary.textContent = `${fixtures.filter((fixture) => Number(fixture.over05Probability) >= 70).length} likely over 0.5`;
    windowSummary.textContent = computeWindowLabel(day);
    notice.textContent = fixtures.length ? `Showing ${fixtures.length} fixtures, kickoff ordered. First-goal timing and fair odds are model estimates, not live exchange prices.` : 'No upcoming fixtures were found in this 8am–8am window.';
    updatedAt.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    statusText.textContent = 'Analysis updated';
  } catch (error) {
    statusText.textContent = 'Connection issue';
    notice.textContent = `Unable to load fixture analysis: ${error.message}`;
    body.innerHTML = `<tr><td colspan="5" class="empty-state"><span class="empty-icon">⌁</span><strong>Fixture feed unavailable</strong><span>${escapeHtml(error.message)}</span></td></tr>`;
  } finally { loading = false; }
}
function getFixtureDecision({ fairOddsAtExpectedMinute, maxProfitOdds, evValue }) {
  const fairOdds = Number.isFinite(Number(fairOddsAtExpectedMinute)) ? Number(fairOddsAtExpectedMinute) : 0;
  const maxProfit = Number.isFinite(Number(maxProfitOdds)) ? Number(maxProfitOdds) : 0;
  const ev = Number.isFinite(Number(evValue)) ? Number(evValue) : 0;
  if (ev > 0.04 && maxProfit >= 1.4) return { className: 'action-green', label: 'Back', detail: 'Strong edge' };
  if (ev > -0.04 || maxProfit >= 1.2 || fairOdds >= 1.8) return { className: 'action-amber', label: 'Caution', detail: 'Monitor price' };
  return { className: 'action-red', label: 'Avoid', detail: 'No edge' };
}
function renderFixtures(fixtures) {
  if (!fixtures.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty-state"><span class="empty-icon">⌁</span><strong>No fixtures in this window</strong><span>Check the next-day tab or come back later.</span></td></tr>';
    return;
  }
  body.innerHTML = fixtures.map((fixture) => {
    const kickoff = new Date(fixture.kickoff);
    const basis = fixture.modelBasis || fixture.probabilitySource || 'Model estimate';
    const confidence = fixture.modelConfidence ? ` · ${fixture.modelConfidence} confidence` : '';
    const expectedMinute = Number.isFinite(Number(fixture.firstGoalExpectedMinute)) ? Math.round(Number(fixture.firstGoalExpectedMinute)) : null;
    const fairOdds = Number.isFinite(Number(fixture.inPlayOver05FairOddsAtExpectedMinute)) ? Number(fixture.inPlayOver05FairOddsAtExpectedMinute) : null;
    const targetOdds = Number.isFinite(Number(fixture.orderRecommendation?.targetOdds)) ? Number(fixture.orderRecommendation.targetOdds) : fairOdds;
    const ev = Number.isFinite(Number(fixture.orderRecommendation?.expectedValue)) ? Number(fixture.orderRecommendation.expectedValue) : null;
    const decision = getFixtureDecision({ fairOddsAtExpectedMinute: fairOdds, maxProfitOdds: targetOdds, evValue: ev });
    const firstGoal = expectedMinute === null ? '—' : `~${expectedMinute}'`;
    const fairText = fairOdds === null ? '—' : fairOdds.toFixed(2);
    const targetText = Number.isFinite(Number(targetOdds)) ? Number(targetOdds).toFixed(2) : '—';
    const evText = ev === null ? '—' : `${ev >= 0 ? '+' : ''}${ev.toFixed(3)}`;
    return `<tr class="fixture-row ${decision.className}"><td class="kickoff-cell"><span class="kickoff-date">${escapeHtml(kickoff.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }))}</span><strong>${escapeHtml(kickoff.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</strong></td><td class="match-cell"><strong>${escapeHtml(fixture.homeTeam || 'Home')}</strong><span class="versus">vs</span><strong>${escapeHtml(fixture.awayTeam || 'Away')}</strong></td><td class="league-cell"><strong>${escapeHtml(fixture.league || 'Competition')}</strong><span>${escapeHtml(fixture.country || '')}</span></td><td class="window-cell"><span>${escapeHtml(basis)}${escapeHtml(confidence)}</span></td><td class="probability-cell"><div class="decision-card ${decision.className}"><div class="decision-header"><span class="decision-badge ${decision.className.replace('action-', '')}">${decision.label}</span><span class="decision-detail">${escapeHtml(decision.detail)}</span></div><div class="decision-metrics"><div class="stat-block"><span>Expected goal time</span><strong>${escapeHtml(firstGoal)}</strong></div><div class="stat-block"><span>Fair odds</span><strong>${escapeHtml(fairText)}</strong></div><div class="stat-block"><span>Max profit odds</span><strong>${escapeHtml(targetText)}</strong></div><div class="stat-block"><span>EV odds</span><strong>${escapeHtml(evText)}</strong></div></div></div></td></tr>`;
  }).join('');
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
viewButtons.forEach((button) => button.addEventListener('click', () => setActiveView(button.dataset.view)));
tabButtons.forEach((button) => button.addEventListener('click', () => loadFixtures(Number(button.dataset.day))));
statsDaySelect.addEventListener('change', (event) => populateStatsInputs(event.target.value));
saveStatsButton.addEventListener('click', saveSelectedDayStats);
clearStatsButton.addEventListener('click', clearSelectedDayStats);
renderStatsOptions();
loadFixtures(0);
window.setInterval(() => loadFixtures(activeDay), 10 * 60_000);
