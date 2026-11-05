import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const config=JSON.parse(await readFile(new URL('../config/analytics/gtm-container.json',import.meta.url),'utf8')).containerVersion;

test('published analytics configuration is explicit, consent gated and excludes automatic personal-data detection',()=>{
  assert.equal(config.container.publicId,'GTM-5635HXLP');
  assert.equal(config.tag.length,2);
  for(const tag of config.tag){
    assert.equal(tag.consentSettings.consentStatus,'NEEDED');
    assert.deepEqual(tag.consentSettings.consentType.list.map(value=>value.value),['analytics_storage']);
    assert.notEqual(tag.type,'html');
  }
  for(const setting of config.gtagConfig)for(const parameter of setting.parameter)assert.equal(parameter.value,'false');
  const initialization=config.tag.find(tag=>tag.type==='dest_ga');
  const parameters=Object.fromEntries(initialization.parameter.find(value=>value.key==='configSettingsTable').list.map(value=>value.map.map(entry=>entry.value)));
  assert.equal(parameters.send_page_view,'false');
  assert.equal(parameters.allow_google_signals,'false');
  assert.equal(parameters.allow_ad_personalization_signals,'false');
  for(const key of ['page_location','page_referrer','page_title'])assert.equal(parameters[key],`{{Public - ${key}}}`);
});

test('container event trigger accepts only public app events and forwards only the explicit safe dimensions',()=>{
  const condition=config.trigger[0].customEventFilter[0];
  assert.equal(condition.type,'MATCH_REGEX');
  const expression=new RegExp(condition.parameter.find(value=>value.key==='arg1').value);
  for(const name of ['page_view','market_select','category_select','analysis_read_mode','news_read_mode','paper_cash_adjustment','paper_entry','paper_close','saved_market'])assert.equal(expression.test(name),true);
  for(const name of ['chat_submit','journal_open','login','purchase','private_paper_entry','paper_entry_secret'])assert.equal(expression.test(name),false);
  const event=config.tag.find(tag=>tag.type==='gaawe');
  const names=event.parameter.find(value=>value.key==='eventParameters').list.map(row=>row.map.find(entry=>entry.key==='name').value);
  assert.deepEqual(names,['page_location','page_referrer','page_title','market_ticker','market_category','reading_mode','cash_action','save_action']);
  assert.equal(config.variable.every(variable=>variable.type==='v'),true);
});
