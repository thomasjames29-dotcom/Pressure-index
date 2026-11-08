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

function computeCurrentDayWindow() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now);
  const map = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  const hour = Number(map.hour || 0);
  const date = `${map.year}-${map.month}-${map.day}`;
  const baseDate = hour >= 8 ? date : addCalendarDays(date, -1);
  return { baseDate, nextDate: addCalendarDays(baseDate, 1) };
}

function addCalendarDays(dateString, amount) {
  const [year, month, day] = dateString.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day + amount));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

async function loadFixtures(day = activeDay) {
  if (loading) return;
  loading = true;
  activeDay = day;
  setActiveTab();
  statusText.textContent = 'Fetching fixture batch…';

  try {
    const url = `/api/fixtures?day=${day}&timezone=${encodeURIComponent(timezone)}`;
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Service returned ${response.status}`);

    const fixtures = Array.isArray(payload.fixtures) ? payload.fixtures : [];
    fixtures.sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
    const likelyCount = fixtures.filter((fixture) => Number(fixture.over05Probability) >= 70).length;

    renderFixtures(fixtures);
    matchCount.textContent = String(fixtures.length);
    likelySummary.textContent = `${likelyCount} ${likelyCount === 1 ? 'fixture' : 'fixtures'}`;

    if (payload.window?.start && payload.window?.end) {
      const start = new Date(payload.window.start);
      const end = new Date(payload.window.end);
      const fmt = (date) => date.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      windowSummary.textContent = `${fmt(start)} – ${fmt(end)}`;
    }

    notice.textContent = fixtures.length
      ? `Showing ${fixtures.length} fixtures for this 8am–8am window, sorted by local kickoff. Some scores may use the baseline estimate when provider prediction data is unavailable.`
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
    const probability = Math.round(clamp(Number(fixture.over05Probability), 0, 100));
    const tone = probability >= 75 ? 'high' : probability >= 55 ? 'medium' : 'low';
    const timeLabel = kickoff.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const dateLabel = kickoff.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    const source = fixture.probabilitySource === 'provider prediction' ? 'Match prediction' : 'Baseline estimate';
    return `<tr class="fixture-row">
      <td class="kickoff-cell"><span class="kickoff-date">${escapeHtml(dateLabel)}</span><strong>${escapeHtml(timeLabel)}</strong></td>
      <td class="match-cell"><strong>${escapeHtml(fixture.homeTeam || 'Home')}</strong><span class="versus">vs</span><strong>${escapeHtml(fixture.awayTeam || 'Away')}</strong></td>
      <td class="league-cell"><strong>${escapeHtml(fixture.league || 'Competition')}</strong><span>${escapeHtml(fixture.country || '')}</span></td>
      <td class="window-cell">${escapeHtml(source)}</td>
      <td class="probability-cell"><div class="probability-chart" role="img" aria-label="${probability}% estimated chance of over 0.5 goals"><div class="probability-top"><strong class="${tone}-text">${probability}%</strong><span>${probability >= 75 ? 'Higher' : probability >= 55 ? 'Moderate' : 'Lower'}</span></div><div class="probability-track"><i class="${tone}" style="width:${probability}%"></i></div></div></td>
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
window.setInterval(() => {
  const { baseDate, nextDate } = computeCurrentDayWindow();
  const selectedWindow = activeDay === 0 ? baseDate : nextDate;
  if (selectedWindow) loadFixtures(activeDay);
}, 600_000);
