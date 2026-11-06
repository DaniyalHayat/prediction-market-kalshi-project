export const CONTRACT_TABS = Object.freeze([
  ['overview', 'Overview'],
  ['research', 'Analysis'],
  ['paper', 'Paper position'],
  ['execution', 'Execution lab'],
  ['rules', 'Rules & sources'],
] as const);

export type ContractTab = typeof CONTRACT_TABS[number][0];
const ids = CONTRACT_TABS.map(([id]) => id);

export function moveContractTab(current: string, key: string): ContractTab | null {
  const index = ids.findIndex(id => id === current);
  if (index < 0) return null;
  if (key === 'Home') return ids[0];
  if (key === 'End') return ids[ids.length - 1];
  if (key === 'ArrowRight') return ids[(index + 1) % ids.length];
  if (key === 'ArrowLeft') return ids[(index - 1 + ids.length) % ids.length];
  return null;
}
