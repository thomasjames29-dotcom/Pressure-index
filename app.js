import { applyBrowserCalibration } from './lib/browser-calibration.mjs';
import { rankInPlay, selectInPlayFixtures } from './lib/inplay-model.mjs';

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
const CALIBRATION_STORAGE_KEY = 'pressure-index-calibration-v1';
const calibrationForm = $('#calibrationForm');
const calibrationLeague = $('#calibrationLeague');
const calibrationSeason = $('#calibrationSeason');
const calibrationStatus = $('#calibrationStatus');
const calibrationButton = $('#calibrationButton');
const clearCalibrationButton = $('#clearCalibrationButton');
const sweepInplayButton = $('#sweepInplayButton');
const inplayStatus = $('#inplayStatus');
const inplayResults = $('#inplayResults');
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
let currentFixtures = [];
let calibrationPending = false;
let inplayCursors = {};
const previousInplay = new Map();

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
    `45–75 ${validCount(stats.min45To75)}`,
    `76–FT ${validCount(stats.min76ToFinish)}`
  ].join(' · ');
}
function updateSelectedDaySummary(date, stats = getStatsForDate(date)) {
  statsDayTotal.textContent = `Selected day total: ${totalGames(stats)} games`;
  statsSummary.textContent = totalGames(stats) ? `${formatStatsDate(date)} — ${formatStatsSummary(stats)}` : `No completed-match stats recorded for ${formatStatsDate(date)}.`;
  const meta = readStorage(STATS_META_KEY)[date];
  if (meta) {
    statsDataStatus.textContent = `${meta.finishedGames} finished games found · ${meta.classifiedGames} classified · ${meta.unclassifiedGames} missing goal-event data. Automatically refreshed ${new Date(meta.updatedAt).toLocaleString()}.`;
  } else {
    statsDataStatus.textContent = 'Choose a day and refresh results to load completed matches. Match totals are based on the provider’s available fixture and goal-event data.';
  }
}
function recentStats(days) {
  const stored = readStorage(STATS_STORAGE_KEY);
  const today = getLocalDateKey();
  const firstDay = addDays(today, -(days - 1));
  const totals = getDefaultStats();
  let recordedDays = 0;
  Object.entries(stored).forEach(([date, counts]) => {
    if (date < firstDay || date > today || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    recordedDays += 1;
    const clean = cleanStats(counts);
    STAT_KEYS.forEach((key) => { totals[key] += clean[key]; });
  });
  return { totals, recordedDays };
}
function renderRecentStats() {
  [[7, stats7DaySummary], [30, stats30DaySummary]].forEach(([days, element]) => {
    const { totals, recordedDays } = recentStats(days);
    element.textContent = recordedDays
      ? `${formatStatsSummary(totals)} · totals from ${recordedDays} recorded ${recordedDays === 1 ? 'day' : 'days'}`
      : 'Refresh individual days to build this total.';
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

    const stats = cleanStats(payload.counts);
    const saved = readStorage(STATS_STORAGE_KEY);
    saved[date] = stats;
    const metadata = readStorage(STATS_META_KEY);
    metadata[date] = {
      finishedGames: validCount(payload.finishedGames),
      classifiedGames: validCount(payload.classifiedGames),
      unclassifiedGames: validCount(payload.unclassifiedGames),
      updatedAt: payload.updatedAt || new Date().toISOString()
    };
    writeStorage(STATS_STORAGE_KEY, saved);
    writeStorage(STATS_META_KEY, metadata);
    populateStatsInputs(date);
    renderRecentStats();
    if (payload.unclassifiedGames) {
      statsDataStatus.textContent += ' Some results lack usable goal events, so the first-goal buckets may be incomplete.';
    }
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
  saved[date] = Object.fromEntries(Object.entries(STATS_FIELDS).map(([key, input]) => [key, validCount(input.value)]));
  if (writeStorage(STATS_STORAGE_KEY, saved)) {
    populateStatsInputs(date);
    renderRecentStats();
    statsDataStatus.textContent = 'Counts saved in this browser. Refresh results to replace them with provider match data.';
  }
}
function clearSelectedDayStats() {
  const date = statsDaySelect.value || getLocalDateKey();
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
  $('#fixtureIntro').hidden = viewName !== 'fixtures';
  $('#fixtureSummary').hidden = viewName !== 'fixtures';
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
function populateCalibrationLeagues(fixtures) {
  const selected = calibrationLeague.value;
  const leagues = new Map();
  fixtures.forEach((fixture) => {
    if (/^[1-9]\d{0,4}$/.test(fixture.leagueId || '') && !leagues.has(fixture.leagueId)) {
      leagues.set(fixture.leagueId, { name: fixture.league || `League ${fixture.leagueId}`, season: Number(fixture.season) });
    }
  });
  calibrationLeague.replaceChildren();
  if (!leagues.size) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No leagues in this window';
    calibrationLeague.append(option);
  } else {
    for (const [id, league] of leagues) {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = `${league.name} (${id})`;
      option.dataset.season = String(league.season);
      calibrationLeague.append(option);
    }
    if (leagues.has(selected)) calibrationLeague.value = selected;
  }
  calibrationButton.disabled = !leagues.size || calibrationPending;
  if (!calibrationSeason.value || (selected && calibrationLeague.value !== selected)) setCalibrationSeason();
}
function setCalibrationSeason() {
  const currentSeason = Number(calibrationLeague.selectedOptions[0]?.dataset.season);
  calibrationSeason.value = String(Number.isInteger(currentSeason) && currentSeason >= 2001
    ? currentSeason - 1
    : new Date().getFullYear() - 1);
}
function renderCurrentFixtures() {
  const saved = readStorage(CALIBRATION_STORAGE_KEY);
  const fixtures = currentFixtures.map((fixture) => applyBrowserCalibration(fixture, saved[fixture.leagueId]));
  renderFixtures(fixtures);
  matchCount.textContent = String(fixtures.length);
  likelySummary.textContent = `${fixtures.filter((fixture) => Number(fixture.over05Probability) >= 70).length} likely over 0.5`;
}
async function runCalibration(event) {
  event.preventDefault();
  if (calibrationPending) return;
  const leagueId = calibrationLeague.value;
  const season = Number(calibrationSeason.value);
  if (!/^[1-9]\d{0,4}$/.test(leagueId) || !Number.isInteger(season) || season < 2000 || season > new Date().getUTCFullYear()) {
    calibrationStatus.textContent = 'Choose a league and a valid season starting year.';
    return;
  }
  calibrationPending = true;
  calibrationButton.disabled = true;
  clearCalibrationButton.disabled = true;
  calibrationStatus.textContent = 'Replaying historical fixtures. This can take a moment…';
  try {
    const response = await fetch(`/api/calibration?league=${encodeURIComponent(leagueId)}&season=${season}`, { headers: { Accept: 'application/json' } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Calibration service returned ${response.status}`);
    if (!payload.eligible) {
      calibrationStatus.textContent = `No update saved: ${payload.trainingCount} training and ${payload.holdoutCount} held-out matches. At least ${payload.minimumTraining}/${payload.minimumHoldout} are required, and both held-out scores must improve. Existing calibration is unchanged.`;
      return;
    }
    if (payload.leagueId !== leagueId || payload.season !== season || typeof payload.modelVersion !== 'string'
      || !Number.isFinite(payload.intercept) || Math.abs(payload.intercept) > 4
      || !Number.isFinite(Date.parse(payload.lastResultAvailableAt))) throw new Error('Invalid calibration result.');
    const saved = readStorage(CALIBRATION_STORAGE_KEY);
    saved[leagueId] = {
      season,
      modelVersion: payload.modelVersion,
      intercept: payload.intercept,
      lastResultAvailableAt: payload.lastResultAvailableAt
    };
    localStorage.setItem(CALIBRATION_STORAGE_KEY, JSON.stringify(saved));
    renderCurrentFixtures();
    calibrationStatus.textContent = `Saved for ${payload.league} (${season}) in this browser. Held-out Brier: ${payload.raw.brierScore} → ${payload.calibrated.brierScore}; log loss: ${payload.raw.logLoss} → ${payload.calibrated.logLoss}. Applies to eligible current or next-season fixtures without xG.`;
  } catch (error) {
    calibrationStatus.textContent = `Calibration not saved: ${error.message}. Existing calibration is unchanged.`;
  } finally {
    calibrationPending = false;
    calibrationButton.disabled = !calibrationLeague.value;
    clearCalibrationButton.disabled = false;
  }
}
function clearCalibration() {
  try {
    localStorage.removeItem(CALIBRATION_STORAGE_KEY);
    renderCurrentFixtures();
    calibrationStatus.textContent = 'Saved calibration cleared from this browser.';
  } catch {
    calibrationStatus.textContent = 'Could not clear calibration. Check browser storage settings.';
  }
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
    currentFixtures = fixtures;
    populateCalibrationLeagues(fixtures);
    renderCurrentFixtures();
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
function getFixtureDecision({ fairOddsAtExpectedMinute, minimumOdds, evValue }) {
  const fairOdds = typeof fairOddsAtExpectedMinute === 'number' ? fairOddsAtExpectedMinute : 0;
  const oddsThreshold = typeof minimumOdds === 'number' ? minimumOdds : 0;
  const ev = typeof evValue === 'number' ? evValue : 0;
  if (ev > 0.04 && oddsThreshold >= 1.4) return { className: 'action-green', label: 'Price check', detail: 'Compare with market' };
  if (ev > -0.04 || oddsThreshold >= 1.2 || fairOdds >= 1.8) return { className: 'action-amber', label: 'Caution', detail: 'Monitor price' };
  return { className: 'action-red', label: 'Avoid', detail: 'No edge' };
}
function renderFixtures(fixtures) {
  if (!fixtures.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty-state"><span class="empty-icon">⌁</span><strong>No fixtures in this window</strong><span>Check the next-day tab or come back later.</span></td></tr>';
    return;
  }
  body.innerHTML = fixtures.map((fixture) => {
    const kickoff = new Date(fixture.kickoff);
    const basis = `${fixture.modelBasis || fixture.probabilitySource || 'Model estimate'}${fixture.calibrationSeason ? ` · 0.5 calibrated (${fixture.calibrationSeason})` : ''}`;
    const confidence = fixture.modelConfidence ? ` · ${fixture.modelConfidence} confidence` : '';
    const expectedMinute = typeof fixture.firstGoalExpectedMinute === 'number' && Number.isFinite(fixture.firstGoalExpectedMinute) ? Math.round(fixture.firstGoalExpectedMinute) : null;
    const fairOdds = typeof fixture.inPlayOver05FairOddsAtExpectedMinute === 'number' && Number.isFinite(fixture.inPlayOver05FairOddsAtExpectedMinute) ? fixture.inPlayOver05FairOddsAtExpectedMinute : null;
    const minimumOdds = typeof fixture.orderRecommendation?.targetOdds === 'number' && Number.isFinite(fixture.orderRecommendation.targetOdds) ? fixture.orderRecommendation.targetOdds : null;
    const evValue = typeof fixture.orderRecommendation?.expectedValue === 'number' && Number.isFinite(fixture.orderRecommendation.expectedValue) ? fixture.orderRecommendation.expectedValue : null;
    const decision = getFixtureDecision({ fairOddsAtExpectedMinute: fairOdds, minimumOdds, evValue });
    const firstGoalTime = expectedMinute === null ? '—' : `~${expectedMinute}'`;
    const over05Text = typeof fixture.over05Probability === 'number' ? `${fixture.over05Probability}%` : '—';
    const over15Text = typeof fixture.over15Probability === 'number' ? `${fixture.over15Probability}%` : '—';
    const zeroZeroText = typeof fixture.zeroZeroProbability === 'number' ? `${fixture.zeroZeroProbability}%` : '—';
    const fairOddsText = fairOdds === null ? '—' : fairOdds.toFixed(2);
    const minimumOddsText = minimumOdds === null ? '—' : minimumOdds.toFixed(2);
    const evText = evValue === null ? '—' : `${evValue >= 0 ? '+' : ''}${evValue.toFixed(3)}`;
    return `<tr class="fixture-row ${decision.className}"><td class="kickoff-cell"><span class="kickoff-date">${escapeHtml(kickoff.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }))}</span><strong>${escapeHtml(kickoff.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</strong></td><td class="match-cell"><strong>${escapeHtml(fixture.homeTeam || 'Home')}</strong><span class="versus">vs</span><strong>${escapeHtml(fixture.awayTeam || 'Away')}</strong></td><td class="league-cell"><strong>${escapeHtml(fixture.league || 'Competition')}</strong><span>${escapeHtml(fixture.country || '')}</span></td><td class="window-cell"><span>${escapeHtml(basis)}${escapeHtml(confidence)}</span></td><td class="probability-cell"><div class="decision-card ${decision.className}"><div class="decision-header"><span class="decision-badge ${decision.className.replace('action-', '')}">${decision.label}</span><span class="decision-detail">${escapeHtml(decision.detail)}</span></div><div class="decision-metrics"><div class="stat-block"><span>Over 0.5 ${fixture.calibrationSeason ? '(calibrated)' : 'chance'}</span><strong>${escapeHtml(over05Text)}</strong></div><div class="stat-block"><span>Over 1.5 chance</span><strong>${escapeHtml(over15Text)}</strong></div><div class="stat-block"><span>0-0 ${fixture.calibrationSeason ? '(calibrated)' : 'chance'}</span><strong>${escapeHtml(zeroZeroText)}</strong></div><div class="stat-block"><span>Expected goal time</span><strong>${escapeHtml(firstGoalTime)}</strong></div><div class="stat-block"><span>Fair odds</span><strong>${escapeHtml(fairOddsText)}</strong></div><div class="stat-block"><span>Minimum odds</span><strong>${escapeHtml(minimumOddsText)}</strong></div><div class="stat-block"><span>Expected value</span><strong>${escapeHtml(evText)}</strong></div></div></div></td></tr>`;
  }).join('');
}
function renderInPlay(matches) {
  if (!matches.length) {
    inplayResults.innerHTML = '<p>No matches with sufficient live statistics were ranked.</p>';
    return;
  }
  inplayResults.innerHTML = [...matches].sort((a, b) => b.rankScore - a.rankScore || b.pressure - a.pressure)
    .map((match, index) => {
      const metric = (value) => value === null ? '—' : value;
      const flags = [match.recentGoal ? 'Recent goal' : '', match.recentRed ? 'Recent red card' : '', !match.eventsAvailable ? 'Recent events unavailable' : ''].filter(Boolean).join(' · ');
      return `<article class="inplay-card"><p>${index + 1}. ${escapeHtml(match.league)}${match.country ? ` · ${escapeHtml(match.country)}` : ''}</p><h3>${escapeHtml(match.homeTeam)} vs ${escapeHtml(match.awayTeam)}</h3><p>${escapeHtml(match.score)} · ${escapeHtml(match.elapsed)}' · sampled ${escapeHtml(new Date(match.observedAt).toLocaleTimeString())}</p><div class="inplay-score">Signal ${escapeHtml(match.rankScore)}/100</div><p>Pressure ${escapeHtml(match.pressure)}/100 · ${match.momentum === null ? 'Momentum unavailable' : `Momentum ${escapeHtml(match.momentum)}/100`}</p><p>Shots ${escapeHtml(metric(match.totals.shots))} · On target ${escapeHtml(metric(match.totals.onTarget))} · Corners ${escapeHtml(metric(match.totals.corners))} · Dangerous attacks ${escapeHtml(metric(match.totals.dangerous))} · xG ${escapeHtml(metric(match.totals.xg))}</p>${flags ? `<p class="inplay-flags">${escapeHtml(flags)}</p>` : ''}</article>`;
    }).join('');
}
async function sweepInPlay() {
  const batchSize = 8;
  sweepInplayButton.disabled = true;
  inplayResults.innerHTML = '';
  inplayStatus.textContent = 'Loading live matches…';
  const matches = [];
  let selected = [];
  let total = 0;
  let processed = 0;
  let unavailable = 0;
  try {
    const response = await fetch('/api/in-play', { headers: { Accept: 'application/json' }, cache: 'no-store' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Live service returned ${response.status}`);
    if (!Array.isArray(payload.fixtures)) throw new Error('Invalid live fixture list.');
    total = payload.fixtures.length;
    if (!total) {
      inplayStatus.textContent = 'No eligible matches are currently in play (minutes 10–80, first or second half).';
      return;
    }
    const selection = selectInPlayFixtures(payload.fixtures, inplayCursors);
    selected = selection.ids;
    for (let i = 0; i < selected.length; i += batchSize) {
      const batch = selected.slice(i, i + batchSize);
      inplayStatus.textContent = `Screening ${processed} of ${selected.length} selected matches (${total} eligible)…`;
      const batchResponse = await fetch('/api/in-play', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: batch }),
        cache: 'no-store'
      });
      const batchPayload = await batchResponse.json().catch(() => ({}));
      if (!batchResponse.ok) throw new Error(batchPayload.error || `Live service returned ${batchResponse.status}`);
      if (!Array.isArray(batchPayload.results) || batchPayload.results.length !== batch.length) throw new Error('Invalid live batch response.');
      for (const result of batchPayload.results) {
        if (!result.match) { unavailable += 1; continue; }
        const match = result.match;
        matches.push(rankInPlay(match, previousInplay.get(match.id)));
        previousInplay.set(match.id, match);
      }
      processed += batch.length;
      renderInPlay(matches);
    }
    inplayCursors = selection.cursors;
    inplayStatus.textContent = `Screened ${processed} of ${total} eligible matches · ${matches.length} ranked · ${unavailable} unavailable · ${total - processed} not screened. ${total > processed ? 'Major leagues are prioritized; later sweeps rotate through overflow. ' : ''}Results are snapshots, not live updates.`;
  } catch (error) {
    renderInPlay(matches);
    inplayStatus.textContent = `Sweep stopped: ${error.message} Screened ${processed} of ${total} eligible matches · ${matches.length} ranked · ${unavailable} unavailable · ${Math.max(0, total - processed)} not screened.`;
  } finally {
    sweepInplayButton.disabled = false;
  }
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

viewButtons.forEach((button) => button.addEventListener('click', () => setActiveView(button.dataset.view)));
sweepInplayButton.addEventListener('click', sweepInPlay);
tabButtons.forEach((button) => button.addEventListener('click', () => loadFixtures(Number(button.dataset.day))));
calibrationForm.addEventListener('submit', runCalibration);
calibrationLeague.addEventListener('change', setCalibrationSeason);
clearCalibrationButton.addEventListener('click', clearCalibration);
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
