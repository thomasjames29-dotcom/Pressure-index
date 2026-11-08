const $ = (selector) => document.querySelector(selector);
const body = $('#matchesBody');
const notice = $('#notice');
const statusText = $('#statusText');
const updatedAt = $('#updatedAt');
const matchCount = $('#matchCount');
const windowSummary = $('#windowSummary');
const likelySummary = $('#likelySummary');

async function loadFixtures() {
  statusText.textContent = 'Fetching fixtures…';

  try {
    const response = await fetch('/api/fixtures', { headers: { Accept: 'application/json' } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Service returned ${response.status}`);

    const fixtures = Array.isArray(payload.fixtures) ? payload.fixtures : [];
    fixtures.sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
    const likelyCount = fixtures.filter((fixture) => Number(fixture.over05Probability) >= 70).length;

    renderFixtures(fixtures);
    matchCount.textContent = String(fixtures.length);
    likelySummary.textContent = `${likelyCount} ${likelyCount === 1 ? 'fixture' : 'fixtures'}`;
    notice.textContent = fixtures.length
      ? `Showing all ${fixtures.length} fixtures in the next 48 hours, ordered by local kickoff time.`
      : 'No fixtures were returned for the next 48 hours.';
    updatedAt.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    statusText.textContent = 'Fixture analysis updated';
  } catch (error) {
    statusText.textContent = 'Connection issue';
    notice.textContent = `Unable to load fixture analysis: ${error.message}`;
    body.innerHTML = `<tr><td colspan="5" class="empty-state"><span class="empty-icon">⌁</span><strong>Fixture feed unavailable</strong><span>${escapeHtml(error.message)}</span></td></tr>`;
  }
}

function renderFixtures(fixtures) {
  if (!fixtures.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty-state"><span class="empty-icon">⌁</span><strong>No fixtures in range</strong><span>Check again later for matches in the next 48 hours.</span></td></tr>';
    return;
  }

  body.innerHTML = fixtures.map((fixture) => {
    const kickoff = new Date(fixture.kickoff);
    const probability = Math.round(clamp(Number(fixture.over05Probability), 0, 100));
    const tone = probability >= 75 ? 'high' : probability >= 55 ? 'medium' : 'low';
    const timeLabel = kickoff.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const dateLabel = kickoff.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    const windowLabel = (kickoff.getTime() - Date.now()) <= 24 * 60 * 60 * 1000 ? '0–24 hours' : '24–48 hours';
    const width = Math.max(0, Math.min(100, probability));

    return `<tr class="fixture-row">
      <td class="kickoff-cell"><span class="kickoff-date">${escapeHtml(dateLabel)}</span><strong>${escapeHtml(timeLabel)}</strong></td>
      <td class="match-cell"><strong>${escapeHtml(fixture.homeTeam || 'Home')}</strong><span class="versus">vs</span><strong>${escapeHtml(fixture.awayTeam || 'Away')}</strong></td>
      <td class="league-cell"><strong>${escapeHtml(fixture.league || 'Competition')}</strong><span>${escapeHtml(fixture.country || '')}</span></td>
      <td class="window-cell">${windowLabel}</td>
      <td class="probability-cell"><div class="probability-chart" role="img" aria-label="${probability}% estimated chance of over 0.5 goals"><div class="probability-top"><strong class="${tone}-text">${probability}%</strong><span>${probability >= 70 ? 'Higher' : probability >= 55 ? 'Moderate' : 'Lower'}</span></div><div class="probability-track"><i class="${tone}" style="width:${width}%"></i></div></div></td>
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

loadFixtures();
window.setInterval(loadFixtures, 5 * 60_000);
