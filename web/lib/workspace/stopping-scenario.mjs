const finite = (value, minimum, maximum, label) => {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(label + ' is outside its permitted range');
  }
};

function mixtureCertaintyEquivalent(lowState, highState, highWeight, risk) {
  if (highWeight === 0) return lowState;
  if (highWeight === 1) return highState;
  if (risk === 0) return (1 - highWeight) * lowState + highWeight * highState;

  const floor = Math.min(lowState, highState);
  const difference = Math.abs(highState - lowState);
  const upperWeight = highState >= lowState ? highWeight : 1 - highWeight;
  return floor - Math.log1p(upperWeight * Math.expm1(-risk * difference)) / risk;
}

function probabilityLattice(initial, step) {
  if (initial === 0 || initial === 1) return {nodes: [initial], initialIndex: 0};

  const below = [];
  const above = [];
  for (let i = 1; initial - i * step > 1e-12; i++) below.push(initial - i * step);
  for (let i = 1; initial + i * step < 1 - 1e-12; i++) above.push(initial + i * step);
  return {nodes: [0, ...below.reverse(), initial, ...above, 1], initialIndex: below.length + 1};
}

export function optionalStoppingScenario({
  initial_probability,
  quantity,
  steps = 12,
  probability_step = .02,
  exit_cost_per_contract = .02,
  current_exit_cash,
  risk_aversion = .02,
  assumptionsAcknowledged = false,
  enabled = true
} = {}) {
  finite(initial_probability, 0, 1, 'Initial probability');
  finite(quantity, 1, 10000, 'Position quantity');
  finite(steps, 1, 64, 'Policy horizon');
  finite(probability_step, .005, .25, 'Probability step');
  finite(exit_cost_per_contract, 0, 1, 'Future exit cost');
  finite(risk_aversion, 0, 10, 'Risk aversion');
  if (!Number.isInteger(steps)) throw new RangeError('The policy horizon must be whole steps');
  if (current_exit_cash !== undefined && current_exit_cash !== null) {
    finite(current_exit_cash, -quantity, quantity, 'Current exit cash');
  }

  const base = {
    method: 'finite_martingale_lattice_cara_stopping',
    classification: 'conditional_paper_stopping_scenario',
    experimental: true,
    paper_only: true,
    affects_forecast: false,
    enabled
  };
  if (assumptionsAcknowledged !== true) {
    return {...base, available: false, reason: 'A bounded fair-value path and future exit-cost assumptions must be explicitly acknowledged.'};
  }

  const expectedHold = initial_probability * quantity;
  const holdCertainty = mixtureCertaintyEquivalent(0, quantity, initial_probability, risk_aversion);
  const baseline = {
    expected_proceeds: expectedHold,
    certainty_equivalent: holdCertainty,
    proceeds_variance: quantity ** 2 * initial_probability * (1 - initial_probability),
    early_exit_probability: 0
  };
  const assumptions = {
    initial_probability,
    quantity,
    steps,
    probability_step,
    exit_cost_per_contract,
    risk_aversion,
    current_exit_cash: current_exit_cash ?? null,
    current_exit_basis: current_exit_cash === undefined ? 'hypothetical_bid_less_assumed_cost' :
      current_exit_cash === null ? 'immediate_exit_unavailable' : 'supplied_net_cash'
  };
  if (!enabled) {
    return {...base, available: true, baseline, policy: {...baseline}, first_action: 'HOLD_TO_SETTLEMENT', assumptions};
  }

  const {nodes, initialIndex} = probabilityLattice(initial_probability, probability_step);
  const upperWeights = nodes.map((price, i) => {
    if (price === 0 || price === 1) return 0;
    return (price - nodes[i - 1]) / (nodes[i + 1] - nodes[i - 1]);
  });
  const exercise = Array.from({length: steps}, () => new Uint8Array(nodes.length));
  const proceeds = (time, index) => {
    if (time === 0 && index === initialIndex && current_exit_cash !== undefined) return current_exit_cash;
    return quantity * Math.max(0, nodes[index] - exit_cost_per_contract);
  };
  let next = nodes.map(price => mixtureCertaintyEquivalent(0, quantity, price, risk_aversion));
  for (let time = steps - 1; time >= 0; time--) {
    const continuation = next;
    next = nodes.map((price, i) => {
      if (price === 0 || price === 1) return quantity * price;

      const wait = mixtureCertaintyEquivalent(continuation[i - 1], continuation[i + 1], upperWeights[i], risk_aversion);
      const sell = proceeds(time, i);
      if (sell !== null && sell > wait + 1e-10) {
        exercise[time][i] = 1;
        return sell;
      }
      return wait;
    });
  }

  let alive = new Float64Array(nodes.length);
  alive[initialIndex] = 1;
  let stoppedMark = 0;
  let expectedCash = 0;
  let expectedSquaredCash = 0;
  let expectedSteps = 0;
  let earlyExit = 0;
  let settlement = 0;
  const exitMassByStep = [];
  for (let time = 0; time <= steps; time++) {
    const future = new Float64Array(nodes.length);
    let exitMass = 0;
    for (let i = 0; i < nodes.length; i++) {
      const mass = alive[i];
      if (mass === 0) continue;

      const price = nodes[i];
      if (time === steps || price === 0 || price === 1) {
        settlement += mass;
        stoppedMark += mass * quantity * price;
        expectedCash += mass * quantity * price;
        expectedSquaredCash += mass * quantity ** 2 * price;
        expectedSteps += mass * time;
      } else if (exercise[time][i]) {
        const cash = proceeds(time, i);
        exitMass += mass;
        stoppedMark += mass * quantity * price;
        expectedCash += mass * cash;
        expectedSquaredCash += mass * cash ** 2;
        expectedSteps += mass * time;
      } else {
        future[i + 1] += mass * upperWeights[i];
        future[i - 1] += mass * (1 - upperWeights[i]);
      }
    }
    earlyExit += exitMass;
    if (exitMass > 0) exitMassByStep.push({step: time, probability: exitMass});
    alive = future;
  }

  const policy = {
    expected_proceeds: expectedCash,
    certainty_equivalent: next[initialIndex],
    proceeds_variance: Math.max(0, expectedSquaredCash - expectedCash ** 2),
    early_exit_probability: earlyExit,
    settlement_probability: settlement,
    expected_steps_held: expectedSteps,
    exit_mass_by_step: exitMassByStep
  };
  return {
    ...base,
    available: true,
    assumptions,
    baseline,
    policy,
    first_action: initial_probability === 0 || initial_probability === 1 ? 'SETTLE' :
      exercise[0][initialIndex] ? 'EXIT' : 'CONTINUE',
    comparison: {
      certainty_equivalent_change: policy.certainty_equivalent - baseline.certainty_equivalent,
      expected_proceeds_change: policy.expected_proceeds - baseline.expected_proceeds,
      expected_gross_stopped_mark: stoppedMark,
      gross_martingale_residual: stoppedMark - expectedHold,
      expected_execution_discount: stoppedMark - expectedCash
    },
    note: 'Backward induction maximizes certainty equivalent in the supplied bounded price lattice. Future bid proceeds use an assumed cost; settlement pays $1 or $0 per contract. The optional stopping identity applies to gross marks under the martingale assumption. Expected proceeds and risk-adjusted utility are reported separately.'
  };
}
