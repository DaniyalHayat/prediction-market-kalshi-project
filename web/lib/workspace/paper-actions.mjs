import {createHash, randomUUID} from 'node:crypto';
import {z} from 'zod';
import {validateTicker} from '../live.mjs';
import {guestSession, openSession, sealSession} from './account.mjs';
import {evaluateQuantScenario} from './quant-context.mjs';

const draftPurpose = 'paper-scenario-draft-v1';
const draftLifetime = 10 * 60_000;
const maxSaved = 8;
const maxRecentDiscards = 24;
const maximumToken = 8000;
const hash = value => createHash('sha256').update(value).digest('hex');
const number = (min, max) => z.number().min(min).max(max);
const tickerInput = z.string().min(1).max(140).regex(/^[A-Za-z0-9_.-]+$/);
const scenarioId = z.uuid();
const confirmed = z.literal(true);
const draftToken = z.string().min(1).max(maximumToken).regex(/^[A-Za-z0-9_-]+$/);
const flag = z.boolean().optional();

const scenarioInput = z.strictObject({
  controls: z.strictObject({hmm: flag, kalman: flag, brownian_mc: flag, optional_stopping: flag}).optional(),
  context_scores: z.array(number(-1, 1)).max(60).optional(),
  score: z.strictObject({
    margin: number(-200, 200), remaining_seconds: number(0, 2880),
    drift_points_per_minute: number(-10, 10), volatility_points_per_sqrt_minute: number(0, 20),
    baseline_probability: number(0, 1).optional(), simulations: z.number().int().min(100).max(20_000).optional(),
    seed: z.number().int().min(0).max(4_294_967_295).optional(),
  }).optional(),
  stopping: z.strictObject({
    initial_probability: number(0, 1), quantity: number(1, 10_000),
    steps: z.number().int().min(1).max(64).optional(), probability_step: number(.005, .25).optional(),
    exit_cost_per_contract: number(0, 1).optional(), current_exit_cash: number(-10_000, 10_000).nullable().optional(),
    risk_aversion: number(0, 10).optional(), assumptionsAcknowledged: confirmed,
  }).optional(),
}).refine(input => input.context_scores?.length || input.score || input.stopping, 'Supply at least one scenario input');

export const paperTools = {
  preview: {name: 'preview_paper_scenario', input: {ticker: tickerInput, scenario: scenarioInput}},
  list: {name: 'list_paper_scenarios', input: {ticker: tickerInput}},
  save: {name: 'save_paper_scenario', input: {ticker: tickerInput, draft_token: draftToken, confirmed}},
  discard: {name: 'discard_paper_scenario', input: {ticker: tickerInput, scenario_id: scenarioId, confirmed}},
};

export const paperRequestInput = z.discriminatedUnion('operation', [
  z.strictObject({operation: z.literal('preview'), ...paperTools.preview.input}),
  z.strictObject({operation: z.literal('list'), ...paperTools.list.input}),
  z.strictObject({operation: z.literal('save'), ...paperTools.save.input}),
  z.strictObject({operation: z.literal('discard'), ...paperTools.discard.input}),
]);

class PaperActionError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export function paperActionError(error) {
  return error instanceof PaperActionError ? {status: error.status, error: error.message} :
    {status: 503, error: 'The paper scenario workspace is temporarily unavailable.'};
}

export function paperGuestCookie(cookieHeader, secure = true) {
  const name = secure ? '__Host-market_guest=' : 'market_guest=';
  const cookies = typeof cookieHeader === 'string' && cookieHeader.length <= 16_000 ?
    cookieHeader.split(';').map(cookie => cookie.trim()).filter(cookie => cookie.startsWith(name)) : [];
  return cookies.length === 1 ? cookies[0] : '';
}

function guestScope(cookieHeader, secret, secure, now) {
  const cookie = paperGuestCookie(cookieHeader, secure);
  const guest = openSession(cookie.slice(cookie.indexOf('=') + 1), secret, 'guest');
  if (!guest || guestSession(guest, now).id !== guest.id) {
    throw new PaperActionError('Open a current guest workspace session first.', 401);
  }
  return {key: 'mcp-paper#' + hash(guest.id), expires: guest.expires};
}

function calculate(inputs) {
  try {
    return evaluateQuantScenario({
      controls: inputs.controls, score: inputs.score, stopping: inputs.stopping,
      context_observations: (inputs.context_scores || []).map((score, index) => ({
        observed_at: new Date(Date.UTC(2000, 0, 1, 0, index)).toISOString(), score,
      })),
    });
  } catch (error) {
    if (error instanceof RangeError) throw new PaperActionError(error.message, 400);
    throw error;
  }
}

function reviewedScenario(draft, result) {
  const {id, ticker, created_at, confirmation_expires_at, inputs} = draft;
  return {id, ticker, created_at, confirmation_expires_at, inputs, result};
}

function scenarioSummary(scenario) {
  const {id, ticker, created_at, saved_at, inputs, result} = scenario;
  return {id, ticker, created_at, saved_at, inputs, paper_only: true, affects_forecast: false,
    context_score: result.context.selected_score, score_probability: result.score.selected_probability,
    stopping_action: result.stopping.first_action ?? null,
    stopping_certainty_equivalent_usd: result.stopping.policy?.certainty_equivalent ?? null};
}

export function createPaperScenarioActions({storage, cookie, secret, secure = true, ticker, now = Date.now} = {}) {
  validateTicker(ticker);
  if (typeof storage?.get !== 'function' || typeof storage?.transaction !== 'function' || typeof storage?.consume !== 'function') {
    throw new PaperActionError('The paper scenario workspace is temporarily unavailable.', 503);
  }
  const scope = guestScope(cookie, secret, secure, now());
  const sk = 'scenarios';
  const empty = () => ({scenarios: [], discards: []});
  const assertCurrent = () => {
    if (now() >= scope.expires) throw new PaperActionError('Open a current guest workspace session first.', 401);
  };
  async function rateLimit() {
    assertCurrent();
    if (!await storage.consume(scope.key, 60, 1, Math.max(1, Math.ceil((scope.expires - now()) / 1000)))) {
      throw new PaperActionError('This guest workspace has reached its scenario allowance.', 429);
    }
  }
  async function change(create, action) {
    return storage.transaction(async client => {
      if (create) {
        await client.query(`INSERT INTO market_lab.records(pk,sk,payload,expires_at) VALUES($1,$2,$3,$4)
          ON CONFLICT(pk,sk) DO NOTHING`, [scope.key, sk, JSON.stringify(empty()), new Date(scope.expires)]);
      }
      const row = (await client.query(`SELECT payload FROM market_lab.records WHERE pk=$1 AND sk=$2
        AND expires_at>clock_timestamp() FOR UPDATE`, [scope.key, sk])).rows[0];
      assertCurrent();
      const state = row?.payload || empty();
      const {reply, changed = false} = action(state);
      if (changed) {
        state.discards = state.discards.filter(item => item.until > now());
        const result = await client.query(`UPDATE market_lab.records SET payload=$3
          WHERE pk=$1 AND sk=$2 AND expires_at>clock_timestamp()`, [scope.key, sk, JSON.stringify(state)]);
        if (result.rowCount !== 1) throw new PaperActionError('Open a current guest workspace session first.', 401);
      }
      return reply;
    });
  }
  return {
    async preview({scenario}) {
      const parsed = scenarioInput.safeParse(scenario);
      if (!parsed.success) throw new PaperActionError('Supply valid bounded paper scenario inputs.', 400);
      await rateLimit();
      const result = calculate(parsed.data), started = now();
      const draft = {id: randomUUID(), ticker, scope: scope.key, inputs: parsed.data,
        created_at: new Date(started).toISOString(), confirmation_expires_at: Math.min(started + draftLifetime, scope.expires),
        result_hash: hash(JSON.stringify(result))};
      return {status: 'draft', draft_token: sealSession(draft, secret, draftPurpose), scenario: reviewedScenario(draft, result)};
    },
    async list() {
      assertCurrent();
      const state = await storage.get(scope.key, sk);
      assertCurrent();
      return {status: 'available', scenarios: (state?.scenarios || []).filter(row => row.ticker === ticker).map(scenarioSummary)};
    },
    async save({draft_token, confirmed: accepted}) {
      if (accepted !== true) throw new PaperActionError('Confirm the reviewed draft before saving.', 400);
      const draft = openSession(draft_token, secret, draftPurpose);
      if (!draft || draft.scope !== scope.key || draft.ticker !== ticker || !scenarioId.safeParse(draft.id).success) {
        throw new PaperActionError('This draft is unavailable in the selected contract and session.', 404);
      }
      return change(true, state => {
        const saved = state.scenarios.find(row => row.id === draft.id && row.ticker === ticker);
        if (saved) return {reply: {status: 'saved', scenario: saved}};
        if (draft.confirmation_expires_at <= now() || state.discards.some(item => item.id === draft.id)) {
          throw new PaperActionError('Preview the scenario again before saving.', 409);
        }
        if (state.scenarios.length >= maxSaved) throw new PaperActionError('Discard a saved paper scenario before saving another.', 409);
        const result = calculate(draft.inputs);
        if (hash(JSON.stringify(result)) !== draft.result_hash) throw new PaperActionError('Preview the scenario again before saving.', 409);
        const scenario = {...reviewedScenario(draft, result), saved_at: new Date(now()).toISOString()};
        state.scenarios.push(scenario);
        return {changed: true, reply: {status: 'saved', scenario}};
      });
    },
    async discard({scenario_id: id, confirmed: accepted}) {
      if (accepted !== true || !scenarioId.safeParse(id).success) throw new PaperActionError('Confirm the selected saved scenario before discarding.', 400);
      return change(false, state => {
        const index = state.scenarios.findIndex(row => row.id === id && row.ticker === ticker);
        if (index < 0) return {reply: {status: 'discarded', scenario_id: id}};
        const until = state.scenarios[index].confirmation_expires_at;
        const discards = state.discards.filter(item => item.until > now());
        if (until > now() && discards.length >= maxRecentDiscards) {
          throw new PaperActionError('Wait for recent scenario drafts to expire before discarding another.', 429);
        }
        state.scenarios.splice(index, 1);
        if (until > now()) discards.push({id, until});
        state.discards = discards;
        return {changed: true, reply: {status: 'discarded', scenario_id: id}};
      });
    },
  };
}
