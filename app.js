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

tabButtons.forEach((button) => button.addEventListener('click', () => loadFixtures(Number(button.dataset.day))));
loadFixtures(0);
window.setInterval(() => loadFixtures(activeDay), 10 * 60_000);

