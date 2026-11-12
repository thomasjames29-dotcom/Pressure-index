export function applyBrowserCalibration(fixture, calibration) {
  if (!calibration || calibration.modelVersion !== fixture.modelVersion
    || !Number.isInteger(Number(fixture.season))
    || !Number.isInteger(calibration.season)
    || Number(fixture.season) < calibration.season
    || Number(fixture.season) > calibration.season + 1
    || fixture.probabilitySource?.includes('xG')
    || !Number.isFinite(calibration.intercept)
    || Math.abs(calibration.intercept) > 4
    || !Number.isFinite(Date.parse(calibration.lastResultAvailableAt))
    || !Number.isFinite(Date.parse(fixture.kickoff))
    || Date.parse(fixture.kickoff) <= Date.parse(calibration.lastResultAvailableAt)
    || !Number.isFinite(fixture.over05ProbabilityExact)
    || fixture.over05ProbabilityExact <= 0 || fixture.over05ProbabilityExact >= 1
    || !Number.isFinite(fixture.over15ProbabilityExact)
    || fixture.over15ProbabilityExact < 0 || fixture.over15ProbabilityExact > 1) return fixture;

  const raw = fixture.over05ProbabilityExact;
  const odds = Math.log(raw / (1 - raw)) + calibration.intercept;
  const probability = 1 / (1 + Math.exp(-odds));
  if (probability < fixture.over15ProbabilityExact) return fixture;
  return {
    ...fixture,
    over05Probability: Math.round(probability * 100),
    zeroZeroProbability: Math.round((1 - probability) * 1000) / 10,
    calibrationSeason: calibration.season
  };
}
