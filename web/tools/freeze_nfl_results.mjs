import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {readJSON} from '../lib/transport.mjs';
import {nflSeasonScoreboardURL, parseNFLScoreboard} from '../lib/workspace/nfl-source.mjs';
import {validateNFL} from '../lib/workspace/nfl-math.mjs';

const archivePath = new URL('../lib/workspace/models/nfl-results.json', import.meta.url);
const validationPath = new URL('../lib/workspace/models/nfl-validation.json', import.meta.url);
const rowsPath = new URL('../research-data/nfl-heldout-predictions-2025.json', import.meta.url);
const hash = value => createHash('sha256').update(value).digest('hex');
const knownSeasons = [2023, 2024, 2025];

async function fetchArchive() {
  const asOf = new Date();
  const byId = new Map(), sources = [];
  for (const year of [2023, 2024, 2025, 2026]) {
    const url = nflSeasonScoreboardURL(year);
    const response = await fetch(url, {signal: AbortSignal.timeout(14000), redirect: 'error'});
    const {data, raw} = await readJSON(response, {source: 'ESPN NFL schedule', maximumBytes: 8000000});
    const {games, rejected} = parseNFLScoreboard(data);
    assert.deepEqual(rejected, [], 'Source event identity and complete game rows are required');
    assert.ok(data.events.length < 1000, 'A capped scoreboard cannot establish complete coverage');
    const selected = games.filter(game => game.season >= 2023 && game.completed && Date.parse(game.played_at) < asOf.getTime());
    for (const game of selected) {
      const prior = byId.get(game.id);
      if (prior) assert.deepEqual(prior, game, 'Repeated game records must agree');
      else byId.set(game.id, game);
    }
    sources.push({kind: 'sports_results', label: 'ESPN NFL scoreboard ' + year, url,
      retrieved_at: new Date().toISOString(), sha256: hash(raw), completed_rows: selected.length});
  }
  return {
    schema_version: 1,
    as_of: asOf.toISOString(),
    sources,
    games: [...byId.values()].sort((a, b) => a.played_at.localeCompare(b.played_at) || a.id.localeCompare(b.id))
  };
}

const refresh = process.argv.includes('--fetch');
const archive = refresh ? await fetchArchive() : JSON.parse(await readFile(archivePath, 'utf8'));
for (const season of knownSeasons) {
  const rows = archive.games.filter(game => game.season === season);
  assert.equal(rows.length, 272, 'Complete regular season required for ' + season);
  const appearances = new Map();
  for (const game of rows) for (const code of [game.home_id, game.away_id]) {
    appearances.set(code, (appearances.get(code) || 0) + 1);
  }
  assert.equal(appearances.size, 32);
  assert.ok([...appearances.values()].every(count => count === 17));
}
const {validation, rows} = validateNFL(archive.games, 2025);
assert.equal(rows.length, 272);
const validationReceipt = {
  ...validation,
  archive_sha256: hash(JSON.stringify(archive.games)),
  prediction_rows_sha256: hash(JSON.stringify(rows)),
  source_as_of: archive.as_of,
  completed_game_counts: Object.fromEntries([...new Set(archive.games.map(game => game.season))].map(season => [
    season, archive.games.filter(game => game.season === season).length
  ]))
};
if (refresh) await writeFile(archivePath, JSON.stringify(archive) + '\n');
await mkdir(new URL('../research-data/', import.meta.url), {recursive: true});
await writeFile(validationPath, JSON.stringify(validationReceipt, null, 2) + '\n');
await writeFile(rowsPath, JSON.stringify(rows) + '\n');
console.log(JSON.stringify(validationReceipt, null, 2));
