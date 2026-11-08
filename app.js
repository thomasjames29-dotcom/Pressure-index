const $ = (selector) => document.querySelector(selector);
const body = $('#matchesBody');
const notice = $('#notice');
const statusText = $('#statusText');
const updatedAt = $('#updatedAt');
const matchCount = $('#matchCount');
const likelySummary = $('#likelySummary');
const windowSummary = $('#windowSummary');
const tabButtons = [...document.querySelectorAll('[data-day]')];
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/London';
let activeDay = 0;
let loading = false;

function computeWindowLabel(day) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hourCycle: 'h23'
  }).formatToParts(now);
  const map = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  const currentDate = `${map.year}-${map.month}-${map.day}`;
  const baseDate = Number(map.hour) >= 8 ? currentDate : addCalendarDays(currentDate, -1);
  const startDate = addCalendarDays(baseDate, day);
  const endDate = addCalendarDays(startDate, 1);
  return `${formatWindowDate(startDate)} – ${formatWindowDate(endDate)}`;
}

function formatWindowDate(dateString) {
  const [year, month, day] = dateString.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 8));
  return new Intl.DateTimeFormat([], { timeZone: timezone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric' }).format(date);
}

function addCalendarDays(dateString, amount) {
  const [year, month, day] = dateString.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + amount));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

async function loadFixtures(day = activeDay) {
  if (loading) return;
  loading = true;
  activeDay = day;
  setActiveTab();
  statusText.textContent = 'Fetching fixture batch…';
  try {
    const response = await fetch(`/api/fixtures?day=${day}&timezone=${encodeURIComponent(timezone)}`, { headers: { Accept: 'application/json' } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Service returned ${response.status}`);

    const fixtures = Array.isArray(payload.fixtures) ? payload.fixtures : [];
    fixtures.sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
    const likelyCount = fixtures.filter((fixture) => Number(fixture.over05Probability) >= 70).length;
    renderFixtures(fixtures);
    matchCount.textContent = String(fixtures.length);
    likelySummary.textContent = `${likelyCount} ${likelyCount === 1 ? 'fixture' : 'fixtures'}`;
    windowSummary.textContent = computeWindowLabel(day);
    notice.textContent = fixtures.length
      ? `Showing ${fixtures.length} fixtures for this 8am–8am window. First-goal times and exchange prices are model estimates, not live market quotes.`
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

function renderFixtures(fixtures) {
  if (!fixtures.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty-state"><span class="empty-icon">⌁</span><strong>No fixtures in this window</strong><span>Check the next-day tab or come back later.</span></td></tr>';
    return;
  }

  body.innerHTML = fixtures.map((fixture) => {
    const kickoff = new Date(fixture.kickoff);
    const probability = clamp(Number(fixture.over05Probability), 0, 100);
    const over15 = clamp(Number(fixture.over15Probability), 0, 100);
    const tone = probability >= 75 ? 'high' : probability >= 55 ? 'medium' : 'low';
    const timeLabel = kickoff.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const dateLabel = kickoff.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    const source = fixture.probabilitySource === 'provider prediction' ? 'Match prediction' : 'Baseline estimate';
    const zeroZeroRisk = Boolean(fixture.zeroZeroRisk);
    const highGoalPotential = Boolean(fixture.highGoalPotential);
    const rowClass = zeroZeroRisk ? 'fixture-row zerozero' : highGoalPotential ? 'fixture-row high-goal' : 'fixture-row';
    const scorelines = Array.isArray(fixture.scorelines)
      ? fixture.scorelines.map((scoreline) => `<span class="scoreline-pill ${scoreline.label === '0-0' ? 'amber' : ''}">${escapeHtml(scoreline.label)} <b>${Math.round(scoreline.probability)}%</b></span>`).join('')
      : '';
    const signal = zeroZeroRisk
      ? '<span class="risk-label amber-label">0-0 risk</span>'
      : highGoalPotential
        ? `<span class="risk-label green-label">Over 1.5 model · ${Math.round(over15)}%</span>`
        : '';
    const expectedMinute = Number.isFinite(Number(fixture.firstGoalExpectedMinute))
      ? `Expected first goal ~${Math.round(Number(fixture.firstGoalExpectedMinute))}′`
      : 'First-goal timing unavailable';
    const oddsLadder = Array.isArray(fixture.inPlayOver05FairOdds)
      ? fixture.inPlayOver05FairOdds.map((step) => `<span class="odds-step">0-0 at ${step.minute}′ <b>${step.fairOdds ? step.fairOdds.toFixed(2) : '—'}</b></span>`).join('')
      : '';

    return `<tr class="${rowClass}">
      <td class="kickoff-cell"><span class="kickoff-date">${escapeHtml(dateLabel)}</span><strong>${escapeHtml(timeLabel)}</strong></td>
      <td class="match-cell"><strong>${escapeHtml(fixture.homeTeam || 'Home')}</strong><span class="versus">vs</span><strong>${escapeHtml(fixture.awayTeam || 'Away')}</strong></td>
      <td class="league-cell"><strong>${escapeHtml(fixture.league || 'Competition')}</strong><span>${escapeHtml(fixture.country || '')}</span></td>
      <td class="window-cell">${escapeHtml(source)}</td>
      <td class="probability-cell">
        <div class="probability-chart" aria-label="${Math.round(probability)}% estimated chance of over 0.5 goals">
          <div class="probability-top"><strong class="${tone}-text">${Math.round(probability)}%</strong><span>${probability >= 75 ? 'Higher' : probability >= 55 ? 'Moderate' : 'Lower'}</span></div>
          <div class="probability-track"><i class="${tone}" style="width:${probability}%"></i></div>
          ${signal}<div class="scoreline-list">${scorelines}</div>
          <div class="first-goal-estimate">${escapeHtml(expectedMinute)}</div>
          <div class="fair-odds-title">Model fair odds for Over 0.5 if still 0-0</div>
          <div class="fair-odds-ladder">${oddsLadder}</div>
        </div>
      </td>
    </tr>`;
  }).join('');
}

function clamp(value, min, max) {
  return Number.isFinite(value) ? Math.min(Math.max(value, min), max) : min;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

tabButtons.forEach((button) => button.addEventListener('click', () => loadFixtures(Number(button.dataset.day))));
loadFixtures(0);
window.setInterval(() => loadFixtures(activeDay), 600_000);
