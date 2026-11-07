import assert from 'node:assert/strict';
import test from 'node:test';
import {contractEvidence} from '../lib/workspace/evidence.mjs';
import {sourceJSON,providerStatus} from '../lib/workspace/providers.mjs';
import {permittedPublicPage} from '../lib/workspace/public-pages.mjs';
import {publicXFeed,redditEvidence} from '../lib/workspace/social.mjs';
import {socialEvidenceEnabled,socialSourceDisabled} from '../lib/workspace/social-policy.mjs';

test('social integrations remain disabled even with stored credentials and explicit client toggles',async()=>{
  const market={ticker:'KXNBAGAME-26NOV07LALBOS-LAL',title:'Los Angeles Lakers win',yes_sub_title:'Los Angeles Lakers'};
  let attempts=0;
  const forbidden=async()=>{attempts++;throw new Error('Social retrieval must remain disabled');};
  const env={X_BEARER_TOKEN:'fixture',REDDIT_CLIENT_ID:'fixture',REDDIT_CLIENT_SECRET:'fixture'};
  assert.equal(socialEvidenceEnabled(env),false);
  assert.equal(socialSourceDisabled('api.x.com',env),true);
  assert.equal(socialSourceDisabled('www.reddit.com',env),true);
  const dependencies={env,sourceJSON:forbidden,permittedPublicPage:forbidden,fetcher:forbidden,store:{get:forbidden}};
  assert.equal((await publicXFeed({enabled:true,topic:'nba'},dependencies)).status,'disabled');
  assert.equal((await redditEvidence(market,{enabled:true,selectedTicker:market.ticker},dependencies)).status,'disabled');
  const evidence=await contractEvidence(market,{enabled:true,selectedTicker:market.ticker,redditEnabled:true,includeX:true},{
    env,publicXFeed:forbidden,redditEvidence:forbidden,sportsNews:async()=>({status:'empty',articles:[]})
  });
  assert.ok(evidence.feeds.filter(row=>['reddit','x'].includes(row.kind)).every(row=>row.status==='disabled'));
  assert.equal(attempts,0);
});

test('network boundaries reject disabled social hosts before robots, cache, quotas or HTTP',async()=>{
  let attempts=0;const fetcher=async()=>{attempts++;throw new Error('Unexpected network call');};
  for(const url of ['https://api.x.com/2/tweets/search/recent','https://www.reddit.com/search/']){
    await assert.rejects(()=>sourceJSON('disabled provider',url,{fetcher}),error=>error.code==='PROVIDER_DISABLED');
    assert.equal((await permittedPublicPage('disabled public page',url,{fetcher})).status,'disabled');
  }
  assert.equal(attempts,0);
  assert.ok(providerStatus().filter(row=>row.id.startsWith('X ')||row.id.startsWith('Reddit ')).every(row=>row.status==='disabled'));
});
