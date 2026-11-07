import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Answer} from '../ui/Assistant.jsx';

const render=(text:string)=>renderToStaticMarkup(createElement(Answer,{text}));

test('assistant citations reject credential-style HTTPS URLs that disguise another host',()=>{
  for(const url of ['https://kalshi.com@evil.example/report','https://reader:password@example.org/report','https://%75ser@example.org/report']){
    const output=render('[Exchange report]('+url+')');
    assert.equal(output.includes('<a '),false);
    assert.ok(output.includes('Exchange report'));
  }
});

test('assistant renders valid HTTPS citations as canonical external links',()=>{
  const output=render('[Source report](https://EXAMPLE.org:443/report?x=1&y=2)');
  assert.ok(output.includes('href="https://example.org/report?x=1&amp;y=2"'));
  assert.ok(output.includes('target="_blank"'));
  assert.ok(output.includes('rel="noreferrer"'));
});

test('assistant leaves invalid schemes and HTML payloads as escaped text',()=>{
  for(const url of ['javascript:alert(1)','data:text/html,<script>alert(1)</script>','http://example.org/report','//example.org/report','https://[invalid/report']){
    const output=render('[Source]('+url+')');
    assert.equal(output.includes('<a '),false);
    assert.equal(output.includes('<script>'),false);
  }
});

