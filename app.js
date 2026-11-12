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
const STATS_META_KEY = 'pressure-index-first-goal-stats-meta';
const statsDaySelect = $('#statsDaySelect');
const statsSummary = $('#statsSummary');
const statsDayTotal = $('#statsDayTotal');
const statsDataStatus = $('#statsDataStatus');
const stats7DaySummary = $('#stats7DaySummary');
const stats30DaySummary = $('#stats30DaySummary');
const refreshStatsButton = $('#refreshStatsButton');
const saveStatsButton = $('#saveStatsButton');
const clearStatsButton = $('#clearStatsButton');
const STATS_FIELDS = {
  noGoals: $('#statsNoGoals'),
  min0To20: $('#stats0To20'),
  min21ToHalftime: $('#stats21ToHalftime'),
  min45To75: $('#stats45To75'),
  min76ToFinish: $('#stats76ToFinish')
};
const STAT_KEYS = Object.keys(STATS_FIELDS);
let activeDay = 0;
let loading = false;
let statsRequestId = 0;

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
function readStorage(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
function writeStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    if (statsDataStatus) statsDataStatus.textContent = 'Could not save to this browser. Check browser storage settings.';
    return false;
  }
}
function getDefaultStats() { return { noGoals: 0, min0To20: 0, min21ToHalftime: 0, min45To75: 0, min76ToFinish: 0 }; }
function cleanStats(value = {}) {
  return Object.fromEntries(STAT_KEYS.map((key) => [key, validCount(value?.[key])]));
}
function getStatsForDate(date) { return cleanStats(readStorage(STATS_STORAGE_KEY)[date]); }
function validCount(value) {
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
}
function totalGames(stats) { return STAT_KEYS.reduce((sum, key) => sum + validCount(stats[key]), 0); }
function formatStatsSummary(stats) {
  return [
    `Goalless ${validCount(stats.noGoals)}`,
    `0–20 ${validCount(stats.min0To20)}`,
    `21–HT ${validCount(stats.min21ToHalftime)}`,
    `46–75 ${validCount(stats.min45To75)}`,
    `76–FT ${validCount(stats.min76ToFinish)}`
  ].join(' · ');
}
function updateSelectedDaySummary(date, stats = getStatsForDate(date)) {
  const saved = readStorage(STATS_STORAGE_KEY);
  const meta = readStorage(STATS_META_KEY)[date];
  if (!Object.hasOwn(saved, date)) {
    statsDayTotal.textContent = 'No results recorded';
    statsSummary.textContent = 'Refresh this day to load results.';
    statsDataStatus.textContent = 'No provider data saved for this day.';
    return;
  }
  const verified = meta?.version === 2 && meta.source === 'provider' && meta.timezone === timezone;
  const complete = verified && meta.complete;
  statsDayTotal.textContent = verified
    ? `${meta.finishedGames} finished${meta.diagnostics?.fixturePagesMissing ? ' found (fixture list incomplete)' : ''} · ${meta.classifiedGames} classified · ${meta.unclassifiedGames} unclassified`
    : `${totalGames(stats)} recorded in categories · finished total unknown`;
  statsSummary.textContent = `${complete ? 'Classified breakdown' : 'INCOMPLETE / UNVERIFIED breakdown (not representative of all games)'}: ${formatStatsSummary(stats)}`;
  if (!verified) {
    statsDataStatus.textContent = 'Manual, older, or different-timezone data is unverified. Refresh this day to check provider coverage.';
    return;
  }
  const d = meta.diagnostics || {};
  statsDataStatus.textContent = `${complete ? 'Complete for finished games returned by the provider' : 'INCOMPLETE: breakdown may be strongly biased'}${date >= getLocalDateKey() ? ' · day still in progress' : ''}. Unclassified: ${d.scoreUnavailable || 0} unavailable scores, ${d.eventsMissing || 0} missing events, ${d.eventsInconsistent || 0} inconsistent events, ${d.eventFailures || 0} provider failures, ${d.eventRateLimited || 0} rate-limited, ${d.eventLimit || 0} not requested due to limits. Missing fixture pages: ${d.fixturePagesMissing || 0} (${d.fixturePageFailures || 0} page failures). Updated ${new Date(meta.updatedAt).toLocaleString()}.`;
}
function recentStats(days) {
  const stored = readStorage(STATS_STORAGE_KEY);
  const metadata = readStorage(STATS_META_KEY);
  const today = getLocalDateKey();
  const firstDay = addDays(today, -(days - 1));
  const totals = getDefaultStats();
  let completeDays = 0;
  let incompleteDays = 0;
  Object.entries(stored).forEach(([date, counts]) => {
    if (date < firstDay || date > today || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    const meta = metadata[date];
    if (date === today || meta?.version !== 2 || meta.source !== 'provider' || meta.timezone !== timezone || !meta.complete) {
      incompleteDays += 1;
      return;
    }
    completeDays += 1;
    const clean = cleanStats(counts);
    STAT_KEYS.forEach((key) => { totals[key] += clean[key]; });
  });
  return { totals, completeDays, incompleteDays, missingDays: days - completeDays - incompleteDays };
}
function renderRecentStats() {
  [[7, stats7DaySummary], [30, stats30DaySummary]].forEach(([days, element]) => {
    const { totals, completeDays, incompleteDays, missingDays } = recentStats(days);
    element.textContent = `${completeDays === days ? 'Complete' : 'INCOMPLETE'}: ${completeDays}/${days} complete days included · ${incompleteDays} incomplete/unverified, ${missingDays} missing. ${completeDays ? formatStatsSummary(totals) : 'No complete days to summarize.'}`;
  });
}
function populateStatsInputs(date) {
  if (!date) return;
  const stats = getStatsForDate(date);
  Object.entries(STATS_FIELDS).forEach(([key, input]) => { input.value = stats[key]; });
  updateSelectedDaySummary(date, stats);
}
function renderStatsOptions(selectedDate = statsDaySelect.value) {
  if (!statsDaySelect) return;
  const today = getLocalDateKey();
  const dates = Array.from({ length: 31 }, (_, index) => addDays(today, -index));
  Object.keys(readStorage(STATS_STORAGE_KEY)).forEach((date) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && !dates.includes(date)) dates.push(date);
  });
  dates.sort((a, b) => b.localeCompare(a));
  statsDaySelect.innerHTML = dates.map((date) => `<option value="${date}">${date === today ? 'Today — ' : ''}${formatStatsDate(date)}</option>`).join('');
  const preferred = selectedDate || addDays(today, -1);
  statsDaySelect.value = dates.includes(preferred) ? preferred : addDays(today, -1);
  populateStatsInputs(statsDaySelect.value);
  renderRecentStats();
}
async function loadStatsForDate(date = statsDaySelect.value, forceRefresh = false) {
  if (!date) return;
  const existing = readStorage(STATS_STORAGE_KEY);
  const existingMeta = readStorage(STATS_META_KEY)[date];
  const unverified = Object.hasOwn(existing, date) && (existingMeta?.version !== 2 || existingMeta.source !== 'provider' || existingMeta.timezone !== timezone);
  if (unverified) {
    if (!forceRefresh) return;
    if (!window.confirm('Replace these manual, older, or different-timezone counts if complete provider results are available?')) return;
  }
  const requestId = ++statsRequestId;
  statsDataStatus.textContent = `Loading completed-match results for ${formatStatsDate(date)}…`;
  refreshStatsButton.disabled = true;
  try {
    const refresh = forceRefresh ? '&refresh=1' : '';
    const response = await fetch(`/api/stats?date=${encodeURIComponent(date)}&timezone=${encodeURIComponent(timezone)}${refresh}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store'
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Stats service returned ${response.status}`);
    if (requestId !== statsRequestId || statsDaySelect.value !== date) return;

    if (payload.version !== 2 || payload.date !== date || payload.timezone !== timezone || typeof payload.complete !== 'boolean' || !payload.counts || !payload.diagnostics ||
        ![payload.finishedGames, payload.classifiedGames, payload.unclassifiedGames, ...STAT_KEYS.map((key) => payload.counts[key])].every((value) => Number.isInteger(value) && value >= 0) ||
        payload.finishedGames !== payload.classifiedGames + payload.unclassifiedGames || totalGames(payload.counts) !== payload.classifiedGames ||
        payload.complete !== (payload.unclassifiedGames === 0 && payload.diagnostics.fixturePagesMissing === 0)) throw new Error('Unrecognized or outdated stats response');
    const stats = cleanStats(payload.counts);
    const saved = readStorage(STATS_STORAGE_KEY);
    if (!payload.complete && Object.hasOwn(saved, date) && (unverified || existingMeta?.complete)) {
      const d = payload.diagnostics;
      statsDataStatus.textContent = `INCOMPLETE refresh: ${payload.finishedGames} finished found · ${payload.classifiedGames} classified · ${payload.unclassifiedGames} unclassified (${d.scoreUnavailable || 0} unavailable scores, ${d.eventsMissing || 0} missing events, ${d.eventsInconsistent || 0} inconsistent events, ${d.eventFailures || 0} provider failures, ${d.eventRateLimited || 0} rate-limited, ${d.eventLimit || 0} limited); ${d.fixturePagesMissing || 0} fixture pages missing. Existing saved counts have been kept.`;
      return;
    }
    saved[date] = stats;
    const metadata = readStorage(STATS_META_KEY);
    metadata[date] = {
      finishedGames: validCount(payload.finishedGames),
      classifiedGames: validCount(payload.classifiedGames),
      unclassifiedGames: validCount(payload.unclassifiedGames),
      updatedAt: payload.updatedAt || new Date().toISOString(),
      version: 2,
      source: 'provider',
      timezone,
      complete: payload.complete,
      diagnostics: payload.diagnostics
    };
    writeStorage(STATS_STORAGE_KEY, saved);
    writeStorage(STATS_META_KEY, metadata);
    populateStatsInputs(date);
    renderRecentStats();
  } catch (error) {
    if (requestId === statsRequestId) {
      statsDataStatus.textContent = `Could not load results: ${error.message}. Existing saved counts have been kept.`;
    }
  } finally {
    if (requestId === statsRequestId) refreshStatsButton.disabled = false;
  }
}
function saveSelectedDayStats() {
  const date = statsDaySelect.value || getLocalDateKey();
  const saved = readStorage(STATS_STORAGE_KEY);
  if (Object.hasOwn(saved, date) && !window.confirm('Replace the saved results for this day with unverified manual counts?')) return;
  statsRequestId += 1;
  refreshStatsButton.disabled = false;
  saved[date] = Object.fromEntries(Object.entries(STATS_FIELDS).map(([key, input]) => [key, validCount(input.value)]));
  if (writeStorage(STATS_STORAGE_KEY, saved)) {
    const metadata = readStorage(STATS_META_KEY);
    metadata[date] = { version: 2, source: 'manual', timezone };
    writeStorage(STATS_META_KEY, metadata);
    populateStatsInputs(date);
    renderRecentStats();
    statsDataStatus.textContent = 'Manual counts saved in this browser; they are unverified and excluded from rolling summaries.';
  }
}
function clearSelectedDayStats() {
  const date = statsDaySelect.value || getLocalDateKey();
  statsRequestId += 1;
  refreshStatsButton.disabled = false;
  const saved = readStorage(STATS_STORAGE_KEY);
  const metadata = readStorage(STATS_META_KEY);
  delete saved[date];
  delete metadata[date];
  writeStorage(STATS_STORAGE_KEY, saved);
  writeStorage(STATS_META_KEY, metadata);
  populateStatsInputs(date);
  renderRecentStats();
  statsDataStatus.textContent = 'Saved counts cleared. Refresh results to fetch the completed matches again.';
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
    notice.textContent = fixtures.length
      ? `Showing ${fixtures.length} fixtures, kickoff ordered. First-goal timing and fair odds are model estimates, not live exchange prices.`
      : 'No upcoming fixtures were found in this 8am–8am window.';
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
    const maxProfitOdds = Number.isFinite(Number(fixture.orderRecommendation?.targetOdds)) ? Number(fixture.orderRecommendation.targetOdds) : fairOdds;
    const evValue = Number.isFinite(Number(fixture.orderRecommendation?.expectedValue)) ? Number(fixture.orderRecommendation.expectedValue) : null;
    const decision = getFixtureDecision({ fairOddsAtExpectedMinute: fairOdds, maxProfitOdds, evValue });
    const firstGoalTime = expectedMinute === null ? '—' : `~${expectedMinute}'`;
    const fairOddsText = fairOdds === null ? '—' : fairOdds.toFixed(2);
    const maxProfitText = Number.isFinite(Number(maxProfitOdds)) ? Number(maxProfitOdds).toFixed(2) : '—';
    const evText = evValue === null ? '—' : `${evValue >= 0 ? '+' : ''}${evValue.toFixed(3)}`;
    return `<tr class="fixture-row ${decision.className}"><td class="kickoff-cell"><span class="kickoff-date">${escapeHtml(kickoff.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }))}</span><strong>${escapeHtml(kickoff.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</strong></td><td class="match-cell"><strong>${escapeHtml(fixture.homeTeam || 'Home')}</strong><span class="versus">vs</span><strong>${escapeHtml(fixture.awayTeam || 'Away')}</strong></td><td class="league-cell"><strong>${escapeHtml(fixture.league || 'Competition')}</strong><span>${escapeHtml(fixture.country || '')}</span></td><td class="window-cell"><span>${escapeHtml(basis)}${escapeHtml(confidence)}</span></td><td class="probability-cell"><div class="decision-card ${decision.className}"><div class="decision-header"><span class="decision-badge ${decision.className.replace('action-', '')}">${decision.label}</span><span class="decision-detail">${escapeHtml(decision.detail)}</span></div><div class="decision-metrics"><div class="stat-block"><span>Expected goal time</span><strong>${escapeHtml(firstGoalTime)}</strong></div><div class="stat-block"><span>Fair odds</span><strong>${escapeHtml(fairOddsText)}</strong></div><div class="stat-block"><span>Max profit odds</span><strong>${escapeHtml(maxProfitText)}</strong></div><div class="stat-block"><span>EV odds</span><strong>${escapeHtml(evText)}</strong></div></div></div></td></tr>`;
  }).join('');
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

viewButtons.forEach((button) => button.addEventListener('click', () => setActiveView(button.dataset.view)));
tabButtons.forEach((button) => button.addEventListener('click', () => loadFixtures(Number(button.dataset.day))));
statsDaySelect.addEventListener('change', (event) => {
  populateStatsInputs(event.target.value);
  loadStatsForDate(event.target.value);
});
refreshStatsButton.addEventListener('click', () => loadStatsForDate(statsDaySelect.value, true));
saveStatsButton.addEventListener('click', saveSelectedDayStats);
clearStatsButton.addEventListener('click', clearSelectedDayStats);
renderStatsOptions(addDays(getLocalDateKey(), -1));
loadStatsForDate(statsDaySelect.value);
loadFixtures(0);
window.setInterval(() => loadFixtures(activeDay), 10 * 60_000);
