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
  return new Intl.DateTimeFormat([], { timeZone: timezone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric' })
    .format(new Date(Date.UTC(year, month - 1, day, 8)));
}

function getLocalDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatStatsDate(dateString) {
  const date = new Date(`${dateString}T12:00:00`);
  return Number.isNaN(date.getTime()) ? dateString : date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

function readStoredStats() {
  try {
    const payload = localStorage.getItem(STATS_STORAGE_KEY);
    return payload ? JSON.parse(payload) : {};
  } catch {
    return {};
  }
}

function writeStoredStats(stats) {
  localStorage.setItem(STATS_STORAGE_KEY, JSON.stringify(stats));
}

function getDefaultStats() {
  return {
    noGoals: 0,
    min0To20: 0,
    min21ToHalftime: 0,
    min45To75: 0,
    min76ToFinish: 0
  };
}

function getStatsForDate(date) {
  const payload = readStoredStats();
  return { ...getDefaultStats(), ...(payload[date] || {}) };
}

function sumStats(statsMap) {
  const total = getDefaultStats();
  Object.values(statsMap).forEach((stats) => {
    total.noGoals += Number(stats.noGoals || 0);
    total.min0To20 += Number(stats.min0To20 || 0);
    total.min21ToHalftime += Number(stats.min21ToHalftime || 0);
    total.min45To75 += Number(stats.min45To75 || 0);
    total.min76ToFinish += Number(stats.min76ToFinish || 0);
  });
  return total;
}

function getRecentDateRange(days) {
  const today = new Date();
  const from = new Date(today);
  from.setDate(from.getDate() - (days - 1));
  from.setHours(0, 0, 0, 0);
  return from;
}

function buildRecentSummary(days) {
  const stats = readStoredStats();
  const cutoff = getRecentDateRange(days);
  const selected = Object.entries(stats).filter(([date]) => {
    const dateValue = new Date(`${date}T12:00:00`);
    return !Number.isNaN(dateValue.getTime()) && dateValue >= cutoff;
  });

  if (!selected.length) {
    return 'No data recorded in this range.';
  }

  const totals = sumStats(Object.fromEntries(selected));
  return [
    `Goalless ${totals.noGoals}`,
    `0–20 ${totals.min0To20}`,
    `21–HT ${totals.min21ToHalftime}`,
    `45–75 ${totals.min45To75}`,
    `76–FT ${totals.min76ToFinish}`
  ].join(' · ');
}

function updateStatsSummary(date) {
  const stats = getStatsForDate(date);
  const total = Object.values(stats).reduce((sum, value) => sum + Number(value || 0), 0);
  if (!total) {
    statsSummary.textContent = `No stats recorded for ${formatStatsDate(date)} yet.`;
    return;
  }

  const rows = [
    `Goalless: ${stats.noGoals}`,
    `0–20: ${stats.min0To20}`,
    `21–HT: ${stats.min21ToHalftime}`,
    `45–75: ${stats.min45To75}`,
    `76–FT: ${stats.min76ToFinish}`
  ];
  statsSummary.textContent = `${formatStatsDate(date)} — ${rows.join(' · ')}`;
}

function renderStatsSummaryPanels() {
  if (!stats7DaySummary || !stats30DaySummary) return;
  stats7DaySummary.textContent = buildRecentSummary(7);
  stats30DaySummary.textContent = buildRecentSummary(30);
}

function populateStatsInputs(date) {
  if (!date) return;
  const stats = getStatsForDate(date);
  Object.entries(STATS_FIELDS).forEach(([key, input]) => {
    const actualKey = key === 'noGoals' ? 'noGoals' : key;
    input.value = Number(stats[actualKey] || 0);
  });
  updateStatsSummary(date);
}

function renderStatsOptions() {
  if (!statsDaySelect) return;
  const allStats = readStoredStats();
  const recordedDays = Object.keys(allStats).sort((a, b) => new Date(b) - new Date(a));
  const today = getLocalDateKey();
  const options = [...new Set([today, ...recordedDays])];

  statsDaySelect.innerHTML = options.map((date) => (
    `<option value="${date}">${formatStatsDate(date)}</option>`
  )).join('');

  const selectedDate = options.includes(statsDaySelect.value) ? statsDaySelect.value : today;
  statsDaySelect.value = selectedDate;
  populateStatsInputs(selectedDate);
  renderStatsSummaryPanels();
}

function saveSelectedDayStats() {
  const date = statsDaySelect.value || getLocalDateKey();
  const stats = readStoredStats();
  stats[date] = {
    noGoals: Number(STATS_FIELDS.noGoals.value || 0),
    min0To20: Number(STATS_FIELDS.min0To20.value || 0),
    min21ToHalftime: Number(STATS_FIELDS.min21ToHalftime.value || 0),
    min45To75: Number(STATS_FIELDS.min45To75.value || 0),
    min76ToFinish: Number(STATS_FIELDS.min76ToFinish.value || 0)
  };
  writeStoredStats(stats);
  renderStatsOptions();
  populateStatsInputs(date);
}

function clearSelectedDayStats() {
  const date = statsDaySelect.value || getLocalDateKey();
  const stats = readStoredStats();
  delete stats[date];
  writeStoredStats(stats);
  renderStatsOptions();
  const nextDate = statsDaySelect.value || getLocalDateKey();
  populateStatsInputs(nextDate);
}

function setActiveView(viewName) {
  const panels = document.querySelectorAll('.view-panel');
  panels.forEach((panel) => {
    const isActive = panel.id === `${viewName}View`;
    panel.classList.toggle('active', isActive);
    panel.hidden = !isActive;
  });

  viewButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.view === viewName);
  });
}

function setupStatsControls() {
  if (!statsDaySelect || !statsSummary || !saveStatsButton || !clearStatsButton) return;

  statsDaySelect.addEventListener('change', (event) => {
    populateStatsInputs(event.target.value);
  });

  saveStatsButton.addEventListener('click', saveSelectedDayStats);
  clearStatsButton.addEventListener('click', clearSelectedDayStats);
  renderStatsOptions();
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
    notice.textContent = fixtures.length
      ? `Showing ${fixtures.length} fixtures, kickoff ordered. First-goal timing and fair odds are model estimates, not live exchange prices.`
      : 'No upcoming fixtures were found in this 8am–8am window.';
    updatedAt.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    statusText.textContent = 'Analysis updated';
  } catch (error) {
    statusText.textContent = 'Connection issue';
    notice.textContent = `Unable to load fixture analysis: ${error.message}`;
    body.innerHTML = `<tr><td colspan="5" class="empty-state"><span class="empty-icon">⌁</span><strong>Fixture feed unavailable</strong><span>${escapeHtml(error.message)}</span></td></tr>`;
  } finally {
    loading = false;
  }
}

function setActiveTab() {
  tabButtons.forEach((button) => {
    const selected = Number(button.dataset.day) === activeDay;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-selected', String(selected));
  });
}

function getFixtureDecision({ fairOddsAtExpectedMinute, maxProfitOdds, evValue }) {
  const fairOdds = Number.isFinite(Number(fairOddsAtExpectedMinute)) ? Number(fairOddsAtExpectedMinute) : 0;
  const maxProfit = Number.isFinite(Number(maxProfitOdds)) ? Number(maxProfitOdds) : 0;
  const ev = Number.isFinite(Number(evValue)) ? Number(evValue) : 0;

  if (ev > 0.04 && maxProfit >= 1.4) {
    return { className: 'action-green', label: 'Back', detail: 'Strong edge' };
  }
  if (ev > -0.04 || maxProfit >= 1.2 || fairOdds >= 1.8) {
    return { className: 'action-amber', label: 'Caution', detail: 'Monitor price' };
  }
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
    const fairOddsAtExpectedMinute = Number.isFinite(Number(fixture.inPlayOver05FairOddsAtExpectedMinute)) ? Number(fixture.inPlayOver05FairOddsAtExpectedMinute) : null;
    const maxProfitOdds = Number.isFinite(Number(fixture.orderRecommendation?.targetOdds)) ? Number(fixture.orderRecommendation.targetOdds) : fairOddsAtExpectedMinute;
    const evValue = Number.isFinite(Number(fixture.orderRecommendation?.expectedValue)) ? Number(fixture.orderRecommendation.expectedValue) : null;

    const decision = getFixtureDecision({ fairOddsAtExpectedMinute, maxProfitOdds, evValue });
    const firstGoalTime = expectedMinute === null ? '—' : `~${expectedMinute}'`;
    const fairOddsText = fairOddsAtExpectedMinute === null ? '—' : fairOddsAtExpectedMinute.toFixed(2);
    const maxProfitText = Number.isFinite(Number(maxProfitOdds)) ? Number(maxProfitOdds).toFixed(2) : '—';
    const evText = evValue === null ? '—' : `${evValue >= 0 ? '+' : ''}${evValue.toFixed(3)}`;

    return `<tr class="fixture-row ${decision.className}">
      <td class="kickoff-cell"><span class="kickoff-date">${escapeHtml(kickoff.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }))}</span><strong>${escapeHtml(kickoff.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</strong></td>
      <td class="match-cell"><strong>${escapeHtml(fixture.homeTeam || 'Home')}</strong><span class="versus">vs</span><strong>${escapeHtml(fixture.awayTeam || 'Away')}</strong></td>
      <td class="league-cell"><strong>${escapeHtml(fixture.league || 'Competition')}</strong><span>${escapeHtml(fixture.country || '')}</span></td>
      <td class="window-cell"><span>${escapeHtml(basis)}${escapeHtml(confidence)}</span></td>
      <td class="probability-cell">
        <div class="decision-card ${decision.className}">
          <div class="decision-header">
            <span class="decision-badge ${decision.className.replace('action-', '')}">${decision.label}</span>
            <span class="decision-detail">${escapeHtml(decision.detail)}</span>
          </div>
          <div class="decision-metrics">
            <div class="stat-block"><span>Expected goal time</span><strong>${escapeHtml(firstGoalTime)}</strong></div>
            <div class="stat-block"><span>Fair odds</span><strong>${escapeHtml(fairOddsText)}</strong></div>
            <div class="stat-block"><span>Max profit odds</span><strong>${escapeHtml(maxProfitText)}</strong></div>
            <div class="stat-block"><span>EV odds</span><strong>${escapeHtml(evText)}</strong></div>
          </div>
        </div>
      </td>
    </tr>`;
  }).join('');
}

function clamp(value, min, max) { return Number.isFinite(value) ? Math.min(Math.max(value, min), max) : min; }
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

if (viewButtons.length) {
  viewButtons.forEach((button) => {
    button.addEventListener('click', () => setActiveView(button.dataset.view));
  });
}

if (tabButtons.length) {
  tabButtons.forEach((button) => button.addEventListener('click', () => loadFixtures(Number(button.dataset.day))));
}

setupStatsControls();
loadFixtures(0);
window.setInterval(() => loadFixtures(activeDay), 10 * 60_000);
