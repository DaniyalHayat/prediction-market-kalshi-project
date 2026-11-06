import test from 'node:test';
import assert from 'node:assert/strict';
import {answerSections,linkParts} from '../ui/assistant-reading.mjs';

test('the first answer keeps its conclusion above details and deduplicates the source tray',()=>{
  const answer='New York wins (KXNFLGAME-26NOV08NYGPHI-NYG)\n\n## The short answer\nThe observed ask is 60 cents.\n\n## Why that matters\nFees raise the entry cost.\n\nSources checked: [Rules](https://example.org/rules), [Book](https://example.org/book), [Rules](https://example.org/rules)';
  const result=answerSections(answer);
  assert.deepEqual(result.sections,[
    {title:'The short answer',lines:['The observed ask is 60 cents.']},
    {title:'Why that matters',lines:['Fees raise the entry cost.']}
  ]);
  assert.deepEqual(result.sources.map(row=>row.url),['https://example.org/rules','https://example.org/book']);
});

test('partially streamed citations remain readable and unsafe URLs remain plain text',()=>{
  const incomplete='[Book](https://example.org/bo';
  assert.deepEqual(linkParts(incomplete),[{text:incomplete}]);
  const unsafe='[Report](https://user:pass@example.org/report)';
  assert.deepEqual(linkParts(unsafe),[{text:unsafe}]);
  assert.deepEqual(answerSections('Sources checked: '+incomplete).sections[0].lines,['Sources checked: '+incomplete]);
});
