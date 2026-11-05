import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {runtimeTelemetry} from '../lib/runtime/telemetry.mjs';

export function replayCatalog(archive) {
  const games = archive.games.filter(game => game.split === 'test' && game.overtime_periods === 0)
    .sort((a, b) => b.played_at.localeCompare(a.played_at)).slice(0, 6).map(game => ({
      id: game.game_id,
      played_at: game.played_at,
      home_id: game.home_id,
      away_id: game.away_id,
      pregame_home_probability: game.pregame_home_probability,
      home_period_scores: game.home_period_scores,
      away_period_scores: game.away_period_scores,
      source_url: game.source.url,
    }));
  if (!games.length) throw new Error('No held-out regulation games in the replay archive');
  return {mode: 'replay', captured_at: archive.captured_at, classification: archive.classification, games};
}

export function createAzureReplayServer({catalog = replayCatalog(JSON.parse(gunzipSync(readFileSync(
  new URL('../research-data/nba-quarter-replay-2026-11-04.json.gz', import.meta.url)
))))} = {}) {
  const archive = JSON.stringify(catalog);
  const health = JSON.stringify({status: 'ok', runtime: 'Azure Container Apps', mode: 'replay', provider_calls: 0});
  return createServer({requestTimeout: 5000, headersTimeout: 5000, maxHeaderSize: 8192}, (req, res) => {
    const started = performance.now();
    const path = req.url.split('?', 1)[0];
    const route = path === '/api/health' || path === '/api/workspace/replay' ? path : 'unknown';
    res.once('finish', () => runtimeTelemetry.observeRequest({route, status: res.statusCode, durationMs: performance.now() - started}));
    const status = !['GET', 'HEAD'].includes(req.method) ? 405 : route === 'unknown' ? 404 : 200;
    const body = status === 405 ? '{"error":"Method not allowed"}' : status === 404 ?
      '{"error":"This route is unavailable in the replay edition"}' : route === '/api/health' ? health : archive;
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': path === '/api/workspace/replay' && status === 200 ? 'public, max-age=300' : 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
}
