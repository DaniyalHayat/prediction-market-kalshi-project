import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument} from 'pdf-lib';
import {buildExecutionPDF} from '../ui/execution-pdf.mjs';
import {executionResearch} from '../lib/workspace/execution-research.mjs';

test('the downloadable PDF parses and paginates a full 60-step submitted scenario',async()=>{
  const ticker='KX-NFL-FIXTURE',now=Date.parse('2026-11-05T03:00:00Z'),as_of=new Date(now).toISOString();
  const book={ticker,as_of,raw:{orderbook_fp:{yes_dollars:[['.40','15']],no_dollars:[['.55','12']]}}};
  const scenario=executionResearch({market:{ticker},book,now,controls:{steps:60},forecast:null});
  const bytes=await buildExecutionPDF({...scenario,title:'A long bracketed contract title (Québec) '.repeat(4),
    forecast:{probability:.61,outcomes:{win:.61,loss:.37,tie:.02},expected_settlement_value:.62},book_as_of:as_of,
    sources:[{label:'Public order book',url:'https://example.test/a/'.padEnd(270,'q'),as_of}]});
  assert.equal(new TextDecoder().decode(bytes.slice(0,5)),'%PDF-');
  const loaded=await PDFDocument.load(bytes);
  assert.equal(loaded.getTitle(),'Predictir | Execution research | KX-NFL-FIXTURE');
  assert.ok(loaded.getPageCount()>=3);
  assert.ok(loaded.getPages().every(page=>page.getWidth()===612&&page.getHeight()===792));
});
