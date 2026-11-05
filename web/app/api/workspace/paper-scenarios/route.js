import {fetchJSON} from '../../../../lib/transport.mjs';
import {azureAccess} from '../../../../lib/workspace/azure-access.mjs';
import {azureBackendOrigin, azureOrigin} from '../../../../lib/workspace/azure-mode.mjs';
import {paperGuestCookie, paperRequestInput, paperTools} from '../../../../lib/workspace/paper-actions.mjs';
import {readProxyBody} from '../../../../lib/workspace/proxy.mjs';
import {validateTicker} from '../../../../lib/live.mjs';

const reply = (body, status = 200) => Response.json(body, {status, headers: {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Cookie',
}});

export async function POST(request) {
  if (process.env.PREDICTIR_MODE !== 'live') return reply({error: 'The hosted paper scenario workspace is unavailable here.'}, 404);
  try {
    const origin = azureOrigin();
    if (!origin || request.headers.get('origin') !== origin || request.headers.get('sec-fetch-site') === 'cross-site') {
      return reply({error: 'Open the paper scenario from the application.'}, 403);
    }
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return reply({error: 'Use a JSON paper scenario request.'}, 415);
    }
    const parsed = paperRequestInput.safeParse(JSON.parse(await readProxyBody(request, 12_000)));
    if (!parsed.success) return reply({error: 'Supply a valid paper scenario action and confirm changes.'}, 400);
    const {operation, ...args} = parsed.data;
    validateTicker(args.ticker);
    const local = !process.env.CONTAINER_APP_NAME && process.env.PREDICTIR_AZURE_LOCAL === '1';
    const suppliedCookies = request.headers.get('cookie');
    const cookie = paperGuestCookie(suppliedCookies) || (local ? paperGuestCookie(suppliedCookies, false) : '');
    if (!cookie) return reply({error: 'Open a current guest workspace session first.'}, 401);
    const access = await azureAccess(request.headers);
    if (access.status !== 200) return reply({error: access.status === 403 ? 'This service is unavailable in your region.' :
      'The regional access check is temporarily unavailable.'}, access.status);
    const backend = azureBackendOrigin(process.env.MARKET_BACKEND_URL, {allowLoopback: local});
    const result = await fetchJSON(new URL('/mcp', backend), {
      method: 'POST', signal: request.signal, timeoutMs: 20_000, maximumBytes: 32_000, redirect: 'error', cache: 'no-store',
      headers: {
        Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', Origin: origin,
        Authorization: 'Bearer ' + process.env.ASSISTANT_SERVICE_SECRET,
        'X-Market-Edge-Secret': process.env.MARKET_EDGE_SECRET, 'X-Market-Paper-Action': '1',
        'X-Market-Country': access.country, 'X-Market-Client-IP': access.ip, 'X-Market-Ticker': args.ticker,
        Cookie: cookie,
      },
      body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: paperTools[operation].name, arguments: args}}),
    });
    const resultText = result.result?.content?.[0]?.text;
    if (typeof resultText !== 'string') throw new Error('Unexpected paper scenario response');
    const packet = JSON.parse(resultText);
    if (result.result.isError) {
      const status = [400, 401, 404, 409, 429].includes(packet.status) ? packet.status : 503;
      return reply({error: status === 503 ? 'The paper scenario workspace is temporarily unavailable.' : packet.error}, status);
    }
    if (!['draft', 'available', 'saved', 'discarded'].includes(packet.status)) throw new Error('Unexpected paper scenario outcome');
    return reply(packet);
  } catch (error) {
    if (error.status === 401) return reply({error: 'Open a current guest workspace session first.'}, 401);
    if (error.status === 429) return reply({error: 'The paper scenario allowance is temporarily exhausted.'}, 429);
    if (error.status === 413) return reply({error: 'The paper scenario request exceeds its size limit.'}, 413);
    if (error instanceof SyntaxError || error instanceof RangeError) return reply({error: 'Supply valid paper scenario JSON.'}, 400);
    return reply({error: 'The paper scenario workspace is temporarily unavailable.'}, 503);
  }
}
