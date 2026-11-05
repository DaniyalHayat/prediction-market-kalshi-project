import test from 'node:test';
import assert from 'node:assert/strict';
import {sanitizeAnalyticsEvent,analyticsPageContext,analyticsConfig,deniedConsent,analyticsProvider} from '../app/components/analytics-policy.mjs';

test('analytics allowlist drops private payloads and rejects private actions and credentials',()=>{
  assert.deepEqual(sanitizeAnalyticsEvent('market_select',{ticker:'KXNBAGAME-26NOV04-CHI',category:'sports',bankroll:1000,probability:.8,journal_token:'private',chat:'secret'}),
    {name:'market_select',params:{market_ticker:'KXNBAGAME-26NOV04-CHI',market_category:'sports'}});
  assert.equal(sanitizeAnalyticsEvent('journal_open',{ticker:'KXNBAGAME-26NOV04-CHI'}),null);
  assert.equal(sanitizeAnalyticsEvent('chat_submit',{category:'sports'}),null);
  assert.equal(sanitizeAnalyticsEvent('market_select',{ticker:'sb_secret_private-key'}),null);
  assert.equal(sanitizeAnalyticsEvent('market_select',{ticker:'KXFOO-..-BAR'}),null);
  assert.equal(sanitizeAnalyticsEvent('category_select',{category:'my-private-journal'}),null);
  assert.deepEqual(sanitizeAnalyticsEvent('category_select',{category:'climate',token:'private'}),{name:'category_select',params:{market_category:'climate'}});
});

test('GTM has priority over direct GA and analytics remains disabled without a valid public ID',()=>{
  assert.equal(analyticsProvider(),null);assert.equal(analyticsProvider({gtm:'secret',ga:'private'}),null);
  assert.deepEqual(analyticsProvider({gtm:'GTM-5635HXLP',ga:'G-EXAMPLE123'}),{kind:'gtm',id:'GTM-5635HXLP'});
  assert.deepEqual(analyticsProvider({gtm:'invalid',ga:'G-EXAMPLE123'}),{kind:'ga',id:'G-EXAMPLE123'});
});
test('paper and read-mode event parameters exclude money, account identity, contract quantity and model inputs',()=>{
  const sensitive={amount:1000,bankroll:20000,email:'private@example.test',password:'secret',quantity:100,probability:.8,chat:'private',ticker:'KXNBAGAME-26NOV04-CHI'};
  assert.deepEqual(sanitizeAnalyticsEvent('paper_cash_adjustment',{...sensitive,action:'add'}),{name:'paper_cash_adjustment',params:{cash_action:'add'}});
  assert.deepEqual(sanitizeAnalyticsEvent('paper_entry',sensitive),{name:'paper_entry',params:{market_ticker:sensitive.ticker}});
  assert.deepEqual(sanitizeAnalyticsEvent('paper_close',sensitive),{name:'paper_close',params:{market_ticker:sensitive.ticker}});
  const event=sanitizeAnalyticsEvent('analysis_read_mode',{...sensitive,mode:'long'});assert.deepEqual(event,{name:'analysis_read_mode',params:{reading_mode:'long_read',market_ticker:sensitive.ticker}});
  assert.deepEqual(sanitizeAnalyticsEvent(event.name,event.params),event);
  assert.equal(sanitizeAnalyticsEvent('paper_cash_adjustment',{action:'withdraw_private'}),null);assert.equal(sanitizeAnalyticsEvent('paper_entry',{ticker:'private-account'}),null);
});
test('analytics page context excludes query, fragment, arbitrary private paths and referrer credentials',()=>{
  assert.deepEqual(analyticsPageContext('https://predictir.dev/?token=private#journal-secret','https://user:password@example.com/messages/private?key=secret'),
    {page_location:'https://predictir.dev/',page_referrer:'https://example.com',page_title:'Predictir'});
  assert.equal(analyticsPageContext('https://predictir.dev/private-owner-token').page_location,'https://predictir.dev/other');
  assert.equal(analyticsPageContext('https://user:secret@predictir.dev/?token=private#secret').page_location,'https://predictir.dev/');
  assert.equal(analyticsPageContext('https://predictir.dev/','javascript:secret').page_referrer,'');
  const config=analyticsConfig('https://predictir.dev/?gclid=secret&utm_source=private');
  assert.equal(config.send_page_view,false);assert.equal(config.allow_google_signals,false);assert.equal(config.allow_ad_personalization_signals,false);
  assert.equal(config.campaign_source,'');assert.equal(config.campaign_id,'');assert.equal(config.linker.accept_incoming,false);
  assert.deepEqual(Object.values(deniedConsent),['denied','denied','denied','denied']);
});
