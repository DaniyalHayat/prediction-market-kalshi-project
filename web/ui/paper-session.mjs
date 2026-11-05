import {PAPER_STORAGE,initializePaperAccount} from './paper-state.mjs';

export function readVerifiedPaperLedger({engine,storage,assertSession}){
  assertSession();
  const stored=engine.readLedger(storage.getItem(PAPER_STORAGE)),ledger=initializePaperAccount(stored);
  if(ledger!==stored)storage.setItem(PAPER_STORAGE,JSON.stringify(ledger));
  return ledger;
}
