const METRICS = {
  shots: ['total shots'],
  onTarget: ['shots on goal', 'shots on target'],
  corners: ['corner kicks'],
  dangerous: ['dangerous attacks'],
  xg: ['expected goals', 'expected goals (xg)', 'expected_goals', 'xg']
};
const PRIORITY_LEAGUES = new Set([
  '1', '2', '3', '4', '6', '9', '15', '39', '40', '45', '61', '66', '71',
  '78', '81', '88', '94', '128', '135', '137', '140', '143', '203', '253', '307', '848'
]);

export function isPriorityLeague(id) {
  return PRIORITY_LEAGUES.has(String(id));
}

export function selectInPlayFixtures(fixtures, cursors = {}) {
  const priority = fixtures.filter((fixture) => fixture.priority);
  const others = fixtures.filter((fixture) => !fixture.priority);
  const rotate = (items, cursor) => items.length
    ? [...items.slice((cursor || 0) % items.length), ...items.slice(0, (cursor || 0) % items.length)]
    : [];
  const high = rotate(priority, cursors.priority);
  const rest = rotate(others, cursors.others);
  const highCount = Math.min(high.length, others.length ? 24 : 32);
  const selectedHigh = high.slice(0, highCount);
  const selectedOthers = rest.slice(0, 32 - selectedHigh.length);
  const extraHigh = high.slice(highCount, highCount + 32 - selectedHigh.length - selectedOthers.length);
  return {
    ids: [...selectedHigh, ...extraHigh, ...selectedOthers].map((fixture) => fixture.id),
    cursors: {
      priority: priority.length ? ((cursors.priority || 0) + selectedHigh.length + extraHigh.length) % priority.length : 0,
      others: others.length ? ((cursors.others || 0) + selectedOthers.length) % others.length : 0
    }
  };
}

function valueForTeam(team, names) {
  const entry = team?.statistics?.find((item) => names.includes(String(item?.type || '').trim().toLowerCase()));
  const value = entry?.value;
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function analyzeInPlay(fixture, statistics, events, observedAt) {
  const elapsed = Number(fixture?.fixture?.status?.elapsed);
  if (!Number.isFinite(elapsed) || elapsed < 10 || elapsed > 80 || !Array.isArray(statistics) || statistics.length !== 2) return null;
  const totals = {};
  for (const [key, names] of Object.entries(METRICS)) {
    const values = statistics.map((team) => valueForTeam(team, names));
    totals[key] = values.every((value) => value !== null) ? values[0] + values[1] : null;
  }
  if (totals.shots === null && totals.onTarget === null) return null;

  const components = [
    { value: totals.shots, scale: 24, weight: 0.25 },
    { value: totals.onTarget, scale: 10, weight: 0.40 },
    { value: totals.corners, scale: 12, weight: 0.15 },
    { value: totals.dangerous, scale: 100, weight: 0.10 },
    { value: totals.xg, scale: 3, weight: 0.10 }
  ].filter((component) => component.value !== null);
  const weight = components.reduce((sum, component) => sum + component.weight, 0);
  const pressure = Math.round(100 * components.reduce((sum, component) =>
    sum + component.weight * Math.min(1, component.value * 90 / elapsed / component.scale), 0) / weight);
  const recentEvents = Array.isArray(events) ? events.filter((event) => {
    const minute = Number(event?.time?.elapsed);
    return Number.isFinite(minute) && minute <= elapsed && minute > elapsed - 10;
  }) : [];
  const recentGoal = recentEvents.some((event) => event.type === 'Goal'
    && !/missed|cancelled|disallowed|annulled|shootout/i.test(`${event.detail || ''} ${event.comments || ''}`));
  const recentRed = recentEvents.some((event) => event.type === 'Card' && /red card/i.test(event.detail || ''));

  return {
    id: String(fixture.fixture.id),
    homeTeam: fixture.teams?.home?.name || 'Home',
    awayTeam: fixture.teams?.away?.name || 'Away',
    league: fixture.league?.name || 'Competition',
    country: fixture.league?.country || '',
    status: fixture.fixture.status.short,
    elapsed,
    score: `${fixture.goals?.home ?? '?'}–${fixture.goals?.away ?? '?'}`,
    pressure,
    totals,
    recentGoal,
    recentRed,
    eventsAvailable: Array.isArray(events),
    observedAt
  };
}

export function rankInPlay(match, previous) {
  const deltaMinute = match.elapsed - (previous?.elapsed ?? match.elapsed);
  const currentTime = Date.parse(match.observedAt);
  const previousTime = Date.parse(previous?.observedAt);
  const wallMinutes = (currentTime - previousTime) / 60000;
  const validPrevious = previous && previous.status === match.status && deltaMinute >= 3 && deltaMinute <= 20
    && Number.isFinite(wallMinutes) && wallMinutes >= 2 && wallMinutes <= 25;
  const components = [
    { key: 'onTarget', scale: 2, weight: 0.6 },
    { key: 'shots', scale: 5, weight: 0.25 },
    { key: 'corners', scale: 3, weight: 0.15 }
  ].filter(({ key }) => validPrevious && match.totals[key] !== null && previous.totals?.[key] !== null
    && Number.isFinite(previous.totals?.[key]) && match.totals[key] >= previous.totals[key]);
  const weight = components.reduce((sum, component) => sum + component.weight, 0);
  const momentum = weight ? Math.round(100 * components.reduce((sum, component) => {
    const delta = match.totals[component.key] - previous.totals[component.key];
    return sum + component.weight * Math.min(1, delta * 10 / deltaMinute / component.scale);
  }, 0) / weight) : null;
  return {
    ...match,
    momentum,
    rankScore: momentum === null ? match.pressure : Math.round(match.pressure * 0.8 + momentum * 0.2)
  };
}
