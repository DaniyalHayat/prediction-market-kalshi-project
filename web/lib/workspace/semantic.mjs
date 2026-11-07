import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {cloudEnabled,store} from '../cloud/store.mjs';
import {validateTicker} from '../live.mjs';
import {safePublicURL,canonicalPublicURL,explicitlyHistorical,sportsEvidenceClaim} from './source-ranking.mjs';
export const EMBEDDING_MODEL=Object.freeze({id:'Xenova/all-MiniLM-L6-v2',revision:'751bff37182d3f1213fa05d7196b954e230abad9',dimensions:384,dtype:'q8',pooling:'mean',normalize:true,device:'cpu'});
const hash=text=>createHash('sha256').update(text).digest('hex');
const clean=(value,maximum)=>String(value||'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,' ').trim().slice(0,maximum);
const memory=new Map(),vectorCache=new Map(),capabilities=new WeakMap(),dailyUsage=new Map();
const embeddingBackfills=new Set();
const DENSE_SEARCH_TIMEOUT_MS=900;
let modelPromise,modelLoadedAt=null,modelFailureUntil=0,queue=Promise.resolve(),queued=0;
export function embeddingStatus(){return {...EMBEDDING_MODEL,status:process.env.SEMANTIC_MODEL_ENABLED==='0'?'disabled':modelLoadedAt?'loaded':modelFailureUntil>Date.now()?'cooldown':'not_loaded',loaded_at:modelLoadedAt,max_parallel_inferences:1,max_queued_requests:4};}
const validVector=value=>Array.isArray(value)&&value.length===384&&value.every(Number.isFinite)&&Math.abs(value.reduce((s,v)=>s+v*v,0)-1)<.01;
export function cosineSimilarity(a,b){if(!validVector(a)||!validVector(b))throw new RangeError('Normalized 384-dimensional embeddings are required');return Math.max(-1,Math.min(1,a.reduce((sum,value,i)=>sum+value*b[i],0)));}
async function extractor(){
  if(process.env.SEMANTIC_MODEL_ENABLED==='0')throw new Error('Local semantic inference is disabled');
  if(modelFailureUntil>Date.now())throw new Error('Local semantic inference is cooling down');
  if(!modelPromise)modelPromise=(async()=>{
    const {pipeline,env}=await import('@huggingface/transformers');env.cacheDir=process.env.SEMANTIC_MODEL_CACHE_DIR||join(tmpdir(),'market-lab-hf-cache');env.allowLocalModels=false;
    const model=await pipeline('feature-extraction',EMBEDDING_MODEL.id,{revision:EMBEDDING_MODEL.revision,dtype:'q8',device:'cpu',session_options:{intraOpNumThreads:1,interOpNumThreads:1}});modelLoadedAt=new Date().toISOString();return model;
  })().catch(()=>{modelPromise=null;modelFailureUntil=Date.now()+300000;throw new Error('The pinned local embedding model is unavailable');});
  return modelPromise;
}
export async function embedPublicTexts(texts){
  if(!Array.isArray(texts)||!texts.length||texts.length>32||texts.some(t=>typeof t!=='string'||!t.trim()||t.length>1200))throw new RangeError('One to 32 public text chunks of at most 1,200 characters are required');
  const keys=texts.map(hash),cached=keys.map(key=>vectorCache.get(key));
  if(cached.every(Boolean))return cached;
  if(queued>=4)throw new Error('The local embedding queue is full');
  const previous=queue;let release;queue=new Promise(resolve=>{release=resolve;});queued++;
  await previous;
  try{
    const output=new Array(texts.length),missing=[];
    texts.forEach((text,i)=>{const key=keys[i],hit=vectorCache.get(key);if(hit)output[i]=hit;else missing.push({text,i,key});});
    if(missing.length){const model=await extractor();for(let i=0;i<missing.length;i+=4){const batch=missing.slice(i,i+4),tensor=await model(batch.map(row=>row.text),{pooling:'mean',normalize:true,truncation:true,max_length:256}),vectors=tensor.tolist();
      if(vectors.length!==batch.length||vectors.some(v=>!validVector(v)))throw new Error('The model returned an invalid embedding shape or norm');
      batch.forEach((row,j)=>{output[row.i]=vectors[j];if(vectorCache.size>=1024)vectorCache.delete(vectorCache.keys().next().value);vectorCache.set(row.key,vectors[j]);});tensor.dispose?.();}}
    return output;
  }finally{queued--;release();}
}
function publicURL(value){const safe=safePublicURL(value);if(!safe||safe.length>2048)return null;const url=new URL(safe);return url.hostname==='api.spotify.com'||/(^|\/)(account|journal|portfolio|internal)(\/|$)/i.test(url.pathname)||[...url.searchParams.keys()].some(k=>/token|secret|password|api.?key/i.test(k))?null:safe;}
function chunks(text){const value=clean(text,12000),rows=[];let start=0;while(start<value.length&&rows.length<8){let end=Math.min(value.length,start+900);if(end<value.length){const space=value.lastIndexOf(' ',end);if(space>start+600)end=space;}rows.push(value.slice(start,end).trim());if(end===value.length)break;start=end-80;}return rows;}
export function publicEvidenceChunks(market,evidence,{now=Date.now()}={}){
  const ticker=validateTicker(market?.ticker);if(evidence?.ticker!==ticker)throw new RangeError('Evidence identity must match the selected contract');
  const rows=[],add=(title,text,url,publisher,kind,published,retrieved,retention=7*86400000)=>{
    url=publicURL(url);const date=Date.parse(retrieved||evidence.as_of),publication=Date.parse(published),expiry=Math.min(date+retention,Number.isFinite(publication)?publication+7*86400000:Infinity);
    if(!url||!Number.isFinite(date)||date>now+300000||expiry<=now||explicitlyHistorical(title,url,now))return;
    for(const content of chunks(text)){rows.push({ticker,id:hash(ticker+'\n'+url+'\n'+content),source_url:url,title:clean(title,400),content,publisher:clean(publisher||'Public source',160),source_kind:kind,published_at:Number.isFinite(publication)?new Date(publication).toISOString():null,retrieved_at:new Date(date).toISOString(),expires_at:new Date(expiry).toISOString()});if(rows.length>=32)break;}
  };
  add(market.title,[market.title,market.yes_sub_title,'Primary settlement rules: '+(market.rules_primary||''),'Secondary settlement rules: '+(market.rules_secondary||'')].join('\n'),'https://external-api.kalshi.com/trade-api/v2/markets/'+encodeURIComponent(ticker),'Kalshi','public_contract_rules',null,evidence.as_of);
  for(const item of [...(evidence.items||[]),...(evidence.related_items||[])]){
    if(rows.length>=32)break;
    if(item.platform==='reddit')continue;
    const scope=item.match_scope==='related'?'related_'+(item.source_tier||'public_metadata'):item.source_tier||'public_metadata';
    add(item.title,[item.title,item.excerpt].filter(Boolean).join('\n'),item.url,item.publisher,scope,item.time_basis==='provider_first_seen'?null:item.published_at||item.as_of,item.retrieved_at||evidence.as_of);
  }
  const music=evidence.music_alternatives;if(rows.length<32&&music?.status==='available')for(const row of (music.matched_tracks||[]).slice(0,3))add('Secondary music chart context',`${row.artist}: ${row.name}. US daily song rank ${row.rank}; reported daily song streams ${row.streams}; measurement date ${row.measurement_date}. ${music.settlement_note}`,music.source_url,'Kworb','secondary_measurement',row.measurement_date,music.as_of);
  return [...new Map(rows.slice(0,32).map(row=>[row.id,row])).values()];
}
async function quota(storage,amount,now,kind='semantic-texts'){
  const day=new Date(now()).toISOString().slice(0,10),index=kind==='evidence-index-chunks',fallback=index?12000:6000,configured=Number(process.env[index?'EVIDENCE_DAILY_CHUNK_LIMIT':'SEMANTIC_DAILY_TEXT_LIMIT']||fallback),limit=Number.isSafeInteger(configured)&&configured>=32?Math.min(index?50000:20000,configured):fallback,key=kind+'#'+day;
  if(storage?.consume)return storage.consume(key,limit,amount,3*86400);
  const used=dailyUsage.get(key)||0;if(used+amount>limit)return false;for(const old of dailyUsage.keys())if(!old.endsWith(day))dailyUsage.delete(old);dailyUsage.set(key,used+amount);return true;
}
async function vectorSchema(db){
  const cached=capabilities.get(db);if(cached&&cached.until>Date.now())return cached.schema;
  const result=await db.query("SELECT n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='vector' AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('market_lab.public_evidence_chunks') AND attname='embedding_vector' AND NOT attisdropped)");
  const schema=result.rows[0]?.schema,value=typeof schema==='string'&&/^[a-z_][a-z0-9_]*$/i.test(schema)?schema:null;capabilities.set(db,{schema:value,until:Date.now()+60000});return value;
}
async function evidenceTransaction(storage,db,run){
  if(typeof storage?.transaction==='function')return storage.transaction(run);
  const client=await db.connect();try{await client.query('BEGIN');const result=await run(client);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export function reciprocalRankFusion(lexical,semantic,{limit=6,constant=60,key=row=>row.id}={}){
  const fused=new Map();
  for(const [kind,list] of [['lexical',lexical],['semantic',semantic]]){
    const seen=new Set();
    for(const row of list){
      const id=key(row);
      if(!id||seen.has(id))continue;
      seen.add(id);
      const current=fused.get(id)||{...row,rrf_score:0,lexical_rank:null,semantic_rank:null};
      current.rrf_score+=1/(constant+seen.size);
      current[kind+'_rank']=seen.size;
      if(kind==='semantic'){
        current.source_cosine_similarity=row.cosine_similarity;
        if(current.id===row.id)current.cosine_similarity=row.cosine_similarity;
      }
      fused.set(id,current);
    }
  }
  return [...fused.values()].sort((a,b)=>b.rrf_score-a.rrf_score||a.id.localeCompare(b.id)).slice(0,limit);
}
function boundedDenseSearch(run){
  const controller=new AbortController();
  let timer;
  const deadline=new Promise(resolve=>{
    timer=setTimeout(()=>{
      controller.abort();
      resolve({rows:[],status:'timed_out',schema:null});
    },DENSE_SEARCH_TIMEOUT_MS);
  });
  return Promise.race([run(controller.signal),deadline]).finally(()=>clearTimeout(timer));
}
const terms=text=>String(text).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu)||[];
const questionWords=new Set(['can','could','does','explain','give','help','how','just','please','tell','the','this','what','when','where','which','why','would','you','your']);
const queryTerms=value=>[...new Set(terms(value))].filter(word=>!questionWords.has(word)).slice(0,16);
function asksSportsAvailability(query){
  return /\b(?:injur\w*|lineups?|starters?|starting (?:quarterback|pitcher)|questionable|ruled out|will miss|sidelined|player availability)\b/i.test(query)&&
    !/\b(?:settle\w*|payout|rules?|void|resolve\w*|resolution)\b/i.test(query);
}
function localLexical(rows,words){
  return rows.map(row=>{
    const title=new Set(terms(row.title)),content=new Set(terms(row.content));
    return {...row,lexical_score:words.reduce((sum,word)=>sum+(title.has(word)?2:Number(content.has(word))),0)};
  }).filter(row=>row.lexical_score>0).sort((a,b)=>b.lexical_score-a.lexical_score).slice(0,30);
}
export function createEvidenceRepository({storage=null,embed=embedPublicTexts,now=Date.now}={}){
  const db=storage?.kind==='postgres'?storage.db:null;
  async function backfill(ticker,pending,schema){
    if(!await quota(storage,pending.length,now))return;
    const vectors=await embed(pending.map(row=>row.content));
    if(vectors.length!==pending.length||vectors.some(v=>!validVector(v)))return;
    const embeddings=new Map(pending.map((row,index)=>[row.id,vectors[index]]));
    if(!db){
      const current=memory.get(ticker);
      if(current)memory.set(ticker,current.map(row=>embeddings.has(row.id)&&Date.parse(row.expires_at)>now()
        ?{...row,embedding:embeddings.get(row.id),model_id:EMBEDDING_MODEL.id,model_revision:EMBEDDING_MODEL.revision}:row));
      return;
    }
    const values=[...embeddings].map(([id,embedding])=>({id,embedding,vector_literal:schema?'['+embedding.join(',')+']':null}));
    await db.query(`UPDATE market_lab.public_evidence_chunks AS chunk SET embedding=x.embedding, model_id=$3, model_revision=$4${schema?', embedding_vector=x.vector_literal::"'+schema+'".vector':''}
      FROM jsonb_to_recordset($2::jsonb) AS x(id char(64), embedding double precision[], vector_literal text)
      WHERE chunk.ticker=$1 AND chunk.id=x.id AND chunk.expires_at>now()
        AND (chunk.embedding IS NULL OR chunk.model_id IS DISTINCT FROM $3 OR chunk.model_revision IS DISTINCT FROM $4)`,
    [ticker,JSON.stringify(values),EMBEDDING_MODEL.id,EMBEDDING_MODEL.revision]);
  }
  function queueBackfill(ticker,pending,schema){
    if(embed===embedPublicTexts&&process.env.SEMANTIC_MODEL_ENABLED==='0')return 'disabled';
    if(embeddingBackfills.has(ticker)||embeddingBackfills.size>=4)return 'refreshing';
    embeddingBackfills.add(ticker);
    setImmediate(()=>backfill(ticker,pending,schema).catch(()=>{}).finally(()=>embeddingBackfills.delete(ticker)));
    return 'queued';
  }
  async function index(market,evidence,{enabled=false,selectedTicker,deferEmbedding=false}={}){
    if(!enabled||selectedTicker!==market?.ticker)return {status:'not_indexed',reason:'Only an explicit evidence load for the exact selected contract can index public sources.'};
    const rows=publicEvidenceChunks(market,evidence,{now:now()});if(!rows.length)return {status:'empty',chunks:0};
    let pending=rows,fresh=rows;
    if(db){try{const existing=await db.query('SELECT id::text,embedding IS NOT NULL AND model_id=$3 AND model_revision=$4 AS embedded FROM market_lab.public_evidence_chunks WHERE ticker=$1 AND id::text=ANY($2::text[]) AND expires_at>now()',[market.ticker,rows.map(r=>r.id),EMBEDDING_MODEL.id,EMBEDDING_MODEL.revision]),done=new Set(existing.rows.filter(r=>r.embedded).map(r=>r.id)),retained=new Set(existing.rows.map(r=>r.id));pending=rows.filter(r=>!done.has(r.id));fresh=rows.filter(r=>!retained.has(r.id));}catch{return {status:'unavailable',chunks:0,reason:'Public evidence migration 006 or the relational store is unavailable.'};}}
    else{const existing=(memory.get(market.ticker)||[]).filter(row=>Date.parse(row.expires_at)>now());pending=rows.filter(r=>!existing.some(old=>old.id===r.id&&validVector(old.embedding)&&old.model_revision===EMBEDDING_MODEL.revision));fresh=rows.filter(r=>!existing.some(old=>old.id===r.id));}
    if(fresh.length&&!await quota(storage,fresh.length,now,'evidence-index-chunks'))return {status:'budget_reached',chunks:0,reason:'The shared daily public evidence storage allowance has been reached.'};
    let vectors=[],semanticStatus=pending.length?'unavailable':'already_indexed';
    if(pending.length&&!deferEmbedding){
      if(await quota(storage,pending.length,now))try{vectors=await embed(pending.map(row=>row.content));if(vectors.length!==pending.length||vectors.some(v=>!validVector(v)))throw new Error('Invalid vectors');semanticStatus='embedded';}catch{vectors=[];}
      else semanticStatus='budget_reached';
    }
    const embedded=new Map(pending.map((row,i)=>[row.id,vectors[i]])),normalized=rows.map(row=>{
      const embedding=embedded.get(row.id)||null;
      return {...row,embedding,model_id:embedding?EMBEDDING_MODEL.id:null,model_revision:embedding?EMBEDDING_MODEL.revision:null};
    });
    if(db){
      const schema=await vectorSchema(db);const values=normalized.map(row=>({...row,vector_literal:row.embedding?'['+row.embedding.join(',')+']':null}));
      await evidenceTransaction(storage,db,async client=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['public-evidence#'+market.ticker]);
      await client.query(`INSERT INTO market_lab.public_evidence_chunks(ticker,id,source_url,title,content,publisher,source_kind,published_at,retrieved_at,expires_at,embedding,model_id,model_revision${schema?',embedding_vector':''})
        SELECT ticker,id,source_url,title,content,publisher,source_kind,published_at,retrieved_at,expires_at,embedding,model_id,model_revision${schema?`,vector_literal::"${schema}".vector`:''} FROM jsonb_to_recordset($1::jsonb) AS x(ticker text,id text,source_url text,title text,content text,publisher text,source_kind text,published_at timestamptz,retrieved_at timestamptz,expires_at timestamptz,embedding double precision[],model_id text,model_revision text,vector_literal text)
        ON CONFLICT(ticker,id) DO UPDATE SET retrieved_at=excluded.retrieved_at,expires_at=excluded.expires_at,embedding=coalesce(excluded.embedding,public_evidence_chunks.embedding),model_id=coalesce(excluded.model_id,public_evidence_chunks.model_id),model_revision=coalesce(excluded.model_revision,public_evidence_chunks.model_revision)${schema?',embedding_vector=coalesce(excluded.embedding_vector,public_evidence_chunks.embedding_vector)':''}`,[JSON.stringify(values)]);
      await client.query('DELETE FROM market_lab.public_evidence_chunks WHERE expires_at<=now() OR (ticker=$1 AND id::text<>ALL($2::text[]))',[market.ticker,rows.map(row=>row.id)]);
      });
      if(deferEmbedding&&pending.length)semanticStatus=queueBackfill(market.ticker,pending,schema);
      return {status:'retained',chunks:rows.length,embedded_chunks:vectors.length,semantic_status:semanticStatus,storage:schema?'postgres_pgvector':'postgres_array',model:EMBEDDING_MODEL};
    }
    const merged=normalized.map(r=>{const old=(memory.get(market.ticker)||[]).find(row=>row.id===r.id);return {...r,embedding:r.embedding||old?.embedding||null,model_id:r.model_id||old?.model_id||null,model_revision:r.model_revision||old?.model_revision||null};});memory.delete(market.ticker);memory.set(market.ticker,merged);
    while([...memory.values()].reduce((s,r)=>s+r.length,0)>2000)memory.delete(memory.keys().next().value);
    if(deferEmbedding&&pending.length)semanticStatus=queueBackfill(market.ticker,pending,null);
    return {status:'retained_ephemeral',chunks:rows.length,embedded_chunks:vectors.length,semantic_status:semanticStatus,storage:'process_memory',model:EMBEDDING_MODEL,reason:'No relational evidence store is configured. Retention is local to this process and disappears on restart.'};
  }
  async function search(ticker,query,{limit=6}={}){
    validateTicker(ticker);if(typeof query!=='string'||query.trim().length<3||query.length>300||!Number.isInteger(limit)||limit<1||limit>8)throw new RangeError('Use a 3–300 character public evidence query and one to eight citations');query=query.trim();
    const sportsGame=/^KX(?:NBA|NFL|EPL)GAME-/.test(ticker);
    const availability=sportsGame&&asksSportsAvailability(query);
    const words=[...new Set([...queryTerms(query),...(availability?['injury','ruled','downgraded','questionable','sidelined','inactive','scratch']:[])])];
    let rows=[],lexical=[],hasEmbeddings=false;
    if(db){try{
      const count=await db.query('SELECT count(*)::int AS n, bool_or(embedding IS NOT NULL AND model_id=$2 AND model_revision=$3) AS embedded FROM market_lab.public_evidence_chunks WHERE ticker=$1 AND expires_at>now()',[ticker,EMBEDDING_MODEL.id,EMBEDDING_MODEL.revision]);if(!count.rows[0]?.n)return emptySearch(ticker,query,'No retained evidence exists for this contract. Use Load contract news first.');
      hasEmbeddings=count.rows[0].embedded===true;
      const result=await db.query(`WITH search AS (SELECT websearch_to_tsquery('english',$2) AS phrase,
          CASE WHEN $3='' THEN NULL ELSE to_tsquery('english',$3) END AS terms)
          SELECT id::text,ticker,source_url,title,content,publisher,source_kind,published_at,retrieved_at,expires_at,
          2*ts_rank_cd(search_document,phrase)+coalesce(ts_rank_cd(search_document,terms),0) AS lexical_score
          FROM market_lab.public_evidence_chunks CROSS JOIN search WHERE ticker=$1 AND expires_at>now()
          AND (search_document@@phrase OR search_document@@terms) ORDER BY lexical_score DESC,retrieved_at DESC,id LIMIT 32`,[ticker,query,words.join(' | ')]);
      lexical=result.rows;
    }catch{return emptySearch(ticker,query,'The retained public evidence store or migration 006 is unavailable.');}}
    else{rows=(memory.get(ticker)||[]).filter(row=>Date.parse(row.expires_at)>now());if(!rows.length)return emptySearch(ticker,query,'No retained evidence exists in this process. Use Load contract news first.');lexical=localLexical(rows,words);hasEmbeddings=rows.some(row=>row.model_id===EMBEDDING_MODEL.id&&row.model_revision===EMBEDDING_MODEL.revision&&validVector(row.embedding));}
    const denseDisabled=embed===embedPublicTexts&&process.env.SEMANTIC_MODEL_ENABLED==='0';
    const emptyDense={rows:[],status:denseDisabled?'disabled':embeddingBackfills.has(ticker)?'refreshing':'unavailable',schema:null};
    const dense=hasEmbeddings&&!denseDisabled?await boundedDenseSearch(async signal=>{
      if(!await quota(storage,1,now))return {...emptyDense,status:'budget_reached'};
      signal.throwIfAborted();
      const [[vector],schema]=await Promise.all([embed([query]),db?vectorSchema(db).catch(()=>null):null]);
      signal.throwIfAborted();
      if(!validVector(vector))throw new Error('Invalid vector');
      let ranked;
      if(schema){
        ranked=(await db.query(`WITH scoped AS MATERIALIZED(SELECT id::text,ticker,source_url,title,content,publisher,source_kind,published_at,retrieved_at,expires_at,embedding_vector FROM market_lab.public_evidence_chunks WHERE ticker=$1 AND expires_at>now() AND model_id=$2 AND model_revision=$3 AND embedding_vector IS NOT NULL ORDER BY retrieved_at DESC,id LIMIT 256) SELECT *,1-(embedding_vector OPERATOR("${schema}".<=>) $4::"${schema}".vector) AS cosine_similarity FROM scoped ORDER BY embedding_vector OPERATOR("${schema}".<=>) $4::"${schema}".vector,id LIMIT 32`,[ticker,EMBEDDING_MODEL.id,EMBEDDING_MODEL.revision,'['+vector.join(',')+']'])).rows;
      }else{
        const candidates=db?(await db.query('SELECT id::text,ticker,source_url,title,content,publisher,source_kind,published_at,retrieved_at,expires_at,embedding FROM market_lab.public_evidence_chunks WHERE ticker=$1 AND expires_at>now() AND model_id=$2 AND model_revision=$3 AND embedding IS NOT NULL ORDER BY retrieved_at DESC,id LIMIT 256',[ticker,EMBEDDING_MODEL.id,EMBEDDING_MODEL.revision])).rows:
          rows.filter(row=>row.model_revision===EMBEDDING_MODEL.revision&&row.model_id===EMBEDDING_MODEL.id);
        ranked=candidates.filter(row=>validVector(row.embedding)).map(row=>({...row,cosine_similarity:cosineSimilarity(vector,row.embedding)}))
          .sort((a,b)=>b.cosine_similarity-a.cosine_similarity||a.id.localeCompare(b.id)).slice(0,32);
      }
      return {rows:ranked.filter(row=>row.cosine_similarity>=.15),status:'available',schema};
    }).catch(()=>({...emptyDense,status:'unavailable'})):emptyDense;
    const current=rows=>rows.filter(row=>{
      if(!publicURL(row.source_url)||explicitlyHistorical(row.title,row.source_url,now()))return false;
      if(!sportsGame)return true;
      if(row.source_kind==='public_contract_rules')return !availability;
      const claim=sportsEvidenceClaim(row.title,row.content,{exactFixture:!row.source_kind?.startsWith('related_')});
      return availability?claim==='availability_report':Boolean(claim);
    });
    const fused=reciprocalRankFusion(current(lexical),current(dense.rows),{limit:64,key:row=>canonicalPublicURL(row.source_url)});
    const ranked=availability?[...fused.filter(row=>!row.source_kind?.startsWith('related_')),
      ...fused.filter(row=>row.source_kind?.startsWith('related_'))]:fused;
    const citations=ranked.slice(0,limit).map((row,index)=>({
      citation_id:'E'+(index+1),id:row.id,ticker,title:row.title,text:row.content,url:row.source_url,publisher:row.publisher,
      source_kind:row.source_kind,published_at:row.published_at,retrieved_at:row.retrieved_at,expires_at:row.expires_at,
      rrf_score:row.rrf_score,lexical_rank:row.lexical_rank,semantic_rank:row.semantic_rank,
      cosine_similarity:row.cosine_similarity??null,source_cosine_similarity:row.source_cosine_similarity??null,
    }));
    return {
      ticker,query,status:citations.length?'available':'no_matches',citations,
      sources:citations.map(c=>({label:c.citation_id+' · '+c.publisher,url:c.url,retrieved_at:c.retrieved_at})),
      retrieval:{
        mode:dense.status==='available'?'hybrid_rrf':'lexical_only',semantic_status:dense.status,
        storage:db?(dense.schema?'postgres_pgvector':'postgres_array'):'process_memory',
        intent:availability?'sports_availability':'general',fusion_unit:'source_url',fusion_constant:60,
        candidate_limit:256,model:EMBEDDING_MODEL,
      },
      as_of:new Date(now()).toISOString(),
      scope:'Only retained public evidence for this exact ticker. Search makes no feed, news, X, Reddit or market requests. Cosine/RRF describe retrieval, independent of factual confidence and trading probabilities.',
    };
  }
  return {index,search};
}
function emptySearch(ticker,query,reason){return {ticker,query,status:'empty',citations:[],sources:[],reason,retrieval:{mode:'not_run',semantic_status:'not_queried'},as_of:new Date().toISOString()};}
const repository=()=>createEvidenceRepository({storage:cloudEnabled()?store():null});
export const retainPublicEvidence=(market,evidence,options)=>repository().index(market,evidence,options);
export const searchRetainedEvidence=(ticker,query,options)=>repository().search(ticker,query,options);
