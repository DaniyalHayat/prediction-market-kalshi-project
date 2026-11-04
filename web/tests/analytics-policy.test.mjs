import test from 'node:test';
import assert from 'node:assert/strict';
import {sanitizeAnalyticsEvent,analyticsPageContext,analyticsConfig,deniedConsent} from '../app/components/analytics-policy.mjs';

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
