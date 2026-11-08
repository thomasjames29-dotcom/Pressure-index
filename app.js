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

    if (!response.ok) {
      throw new Error(payload.error || `Service returned ${response.status}`);
    }

    const fixtures = Array.isArray(payload.fixtures) ? payload.fixtures : [];
    const sorted = [...fixtures].sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
    const likelyCount = sorted.filter((fixture) => Number(fixture.over05Probability) >= 50).length;

    renderFixtures(sorted);

    const now = new Date();
    const start = now.toLocaleDateString([], { month: 'short', day: 'numeric' });
    const end = new Date(now.getTime() + 48 * 60 * 60 * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' });

    windowSummary.textContent = `${start} to ${end}`;
    likelySummary.textContent = `${likelyCount} ${likelyCount === 1 ? 'match' : 'matches'}`;
    matchCount.textContent = String(sorted.length);
    notice.textContent = sorted.length
      ? `Showing ${sorted.length} fixtures in the next 48 hours. ${likelyCount} are forecasted to see over 0.5 goals.`
      : 'No upcoming fixtures were found in the next 48 hours.';
    updatedAt.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    statusText.textContent = 'Fixture watchlist updated';
  } catch (error) {
    statusText.textContent = 'Connection issue';
    notice.textContent = `Unable to load pre-match data: ${error.message}`;
    body.innerHTML = `
      <tr>
        <td colspan="5" class="empty-state">
          <span class="empty-icon">⌁</span>
          <strong>Fixture feed unavailable</strong>
          <span>${escapeHtml(error.message)}</span>
        </td>
      </tr>
    `;
  }
}

function renderFixtures(items) {
  if (!items.length) {
    body.innerHTML = `
      <tr>
        <td colspan="5" class="empty-state">
          <span class="empty-icon">⌁</span>
          <strong>No fixtures in range</strong>
          <span>There are no upcoming matches in the next 48 hours.</span>
        </td>
      </tr>
    `;
    return;
  }

  body.innerHTML = items.map((fixture) => {
    const kickoff = new Date(fixture.kickoff);
    const probability = clamp(Number(fixture.over05Probability) || 0, 0, 100);
    const tone = probability >= 60 ? 'high' : probability >= 45 ? 'medium' : 'low';
    const kickOffText = kickoff.toLocaleString([], {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });

    const windowLabel = fixture.windowLabel || getWindowLabel(fixture.kickoff);

    return `
      <tr class="fixture-row ${tone}">
        <td class="kickoff-cell">
          <span class="day-tag">${kickoff.toLocaleDateString([], { weekday: 'short' })}</span>
          <strong>${kickOffText}</strong>
        </td>
        <td class="match-cell">
          <div class="home-team">${escapeHtml(fixture.homeTeam || 'Home')}</div>
          <div class="versus">vs</div>
          <div class="away-team">${escapeHtml(fixture.awayTeam || 'Away')}</div>
        </td>
        <td class="league-cell">${escapeHtml(fixture.league || 'Competition')}</td>
        <td class="window-cell">${escapeHtml(windowLabel)}</td>
        <td class="probability-cell">
          <div class="probability-badge ${tone}">${Math.round(probability)}%</div>
        </td>
      </tr>
    `;
  }).join('');
}

function getWindowLabel(dateString) {
  const hoursRemaining = (new Date(dateString) - new Date()) / (1000 * 60 * 60);
  if (hoursRemaining <= 24) return '0-24h';
  if (hoursRemaining <= 48) return '24-48h';
  return 'Later';
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

loadFixtures();
window.setInterval(loadFixtures, 60_000);
