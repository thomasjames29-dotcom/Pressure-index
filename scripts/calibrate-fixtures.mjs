import { pathToFileURL } from 'node:url';
import { buildCalibrationReport, replayLeagueSeason as replay } from '../lib/fixture-calibration.mjs';
import * as model from '../functions/api/fixtures.js';

export { buildCalibrationReport };
export function replayLeagueSeason(leagueId, season, key) {
  return replay(leagueId, season, key, model);
}

async function main() {
  const key = process.env.APIFOOTBALL_KEY;
  if (!key) throw new Error('Set APIFOOTBALL_KEY in the environment; the value is never written to the report.');
  const values = process.argv.slice(2);
  if (!values.length) throw new Error('Provide one or more league:season pairs, e.g. 39:2025 140:2025.');
  const seasons = [];
  for (const value of values) {
    const match = /^(\d+):(\d{4})$/.exec(value);
    if (!match) throw new Error(`Invalid league:season pair: ${value}`);
    process.stderr.write(`Replaying league ${match[1]}, season ${match[2]}…\n`);
    seasons.push(await replayLeagueSeason(match[1], match[2], key));
  }
  process.stdout.write(`${JSON.stringify(buildCalibrationReport(seasons), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Calibration replay failed.'}\n`);
    process.exitCode = 1;
  });
}
