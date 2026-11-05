import {createHash, randomUUID} from 'node:crypto';
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand, TransactWriteCommand} from '@aws-sdk/lib-dynamodb';
import {S3Client, PutObjectCommand, GetObjectCommand} from '@aws-sdk/client-s3';
import {SSMClient, GetParameterCommand} from '@aws-sdk/client-ssm';
import {makePostgresStore} from '../postgres-store.mjs';

const config={region:process.env.AWS_REGION || 'us-east-2',maxAttempts:2};
const sha=value=>createHash('sha256').update(value).digest('hex');
export const cloudEnabled=()=>Boolean(process.env.DATABASE_URL || process.env.MARKET_TABLE);
let active,credentials;
export function store() {
  if(!active && process.env.DATABASE_URL)active=makePostgresStore();
  if(!active)active=makeStore(DynamoDBDocumentClient.from(new DynamoDBClient(config),{marshallOptions:{removeUndefinedValues:true}}),
    {table:process.env.MARKET_TABLE,bucket:process.env.MARKET_BUCKET,s3:new S3Client(config)});
  return active;
}
export async function closeStore(){await active?.close?.();}
export async function streamCredentials() {
  if(process.env.KALSHI_API_KEY_ID && process.env.KALSHI_PRIVATE_KEY)return {id:process.env.KALSHI_API_KEY_ID,pem:process.env.KALSHI_PRIVATE_KEY};
  if(!process.env.KALSHI_SECRET_PARAMETER)return null;
  if(!credentials)credentials=new SSMClient(config).send(new GetParameterCommand({Name:process.env.KALSHI_SECRET_PARAMETER,WithDecryption:true}))
    .then(r=>JSON.parse(r.Parameter.Value)).catch(error=>{credentials=null;throw error;});
  return credentials;
}
export function makeStore(client,{table,bucket,s3,now=Date.now}) {
  const base={TableName:table},denied=new Map();
  const get=async(pk,sk='value')=>(await client.send(new GetCommand({...base,Key:{pk,sk},ConsistentRead:true}))).Item;
  const put=async item=>client.send(new PutCommand({...base,Item:item,ConditionExpression:'attribute_not_exists(pk)'}));
  async function consume(key,limit,amount=1,ttl=172800) {
    if(!Number.isInteger(limit)||!Number.isInteger(amount)||amount<1||amount>limit)throw new RangeError('Invalid quota');
    if((denied.get(key)||0)>now())return false;
    try {
      await client.send(new UpdateCommand({...base,Key:{pk:'quota#'+key,sk:'value'},
        UpdateExpression:'SET expires_epoch = :ttl ADD #used :amount',
        ConditionExpression:'attribute_not_exists(#used) OR #used <= :threshold',
        ExpressionAttributeNames:{'#used':'used'},ExpressionAttributeValues:{':ttl':Math.floor(now()/1000)+ttl,':amount':amount,':threshold':limit-amount}}));
      return true;
    } catch(error) {
      if(error.name!=='ConditionalCheckFailedException')throw error;
      denied.set(key,now()+60000);return false;
    }
  }
  async function lease(key,seconds=30) {
    const owner=randomUUID(),pk='lease#'+key;
    try {
      await client.send(new PutCommand({...base,Item:{pk,sk:'value',owner,expires_epoch:Math.floor(now()/1000)+seconds},
        ConditionExpression:'attribute_not_exists(pk) OR expires_epoch < :now',ExpressionAttributeValues:{':now':Math.floor(now()/1000)}}));
    } catch(error) {if(error.name==='ConditionalCheckFailedException')return null;throw error;}
    return async()=>{
      try{await client.send(new DeleteCommand({...base,Key:{pk,sk:'value'},ConditionExpression:'#owner = :owner',
        ExpressionAttributeNames:{'#owner':'owner'},ExpressionAttributeValues:{':owner':owner}}));}
      catch(error){if(error.name!=='ConditionalCheckFailedException')throw error;}
    };
  }
  async function archive(key,value) {
    const body=JSON.stringify(value),hash=sha(body);
    try {await s3.send(new PutObjectCommand({Bucket:bucket,Key:key,Body:body,ContentType:'application/json',
      ServerSideEncryption:'AES256',IfNoneMatch:'*',Metadata:{sha256:hash}}));}
    catch(error){if(error.name!=='PreconditionFailed')throw error;}
    return {key,sha256:hash};
  }
  async function cached(key,seconds,producer) {
    const pk='cache#'+sha(key),existing=await get(pk);
    async function decode(item) {
      if(!item || item.expires_epoch<=Math.floor(now()/1000))return null;
      if(item.value)return item.value;
      const r=await s3.send(new GetObjectCommand({Bucket:bucket,Key:item.object_key}));
      const body=await r.Body.transformToString();
      if(sha(body)!==item.sha256)throw new Error('Cache object integrity failure');
      return JSON.parse(body);
    }
    const hit=await decode(existing);if(hit)return hit;
    const release=await lease(pk,25);
    if(!release){
      for(let i=0;i<8;i++){
        await new Promise(resolve=>setTimeout(resolve,150));
        const value=await decode(await get(pk));if(value)return value;
      }
      const e=new Error('A matching data request is in progress; retry shortly');e.status=429;throw e;
    }
    try {
      if(!await consume('upstream#'+new Date(now()).toISOString().slice(0,10),12000)){
        const e=new Error('Daily upstream allowance reached');e.status=429;throw e;
      }
      const value=await producer(),body=JSON.stringify(value),item={pk,sk:'value',expires_epoch:Math.floor(now()/1000)+seconds};
      if(Buffer.byteLength(body)<240000)item.value=value;
      else Object.assign(item,{object_key:'cache/'+sha(body)+'.json',...(await archive('cache/'+sha(body)+'.json',value))});
      await client.send(new PutCommand({...base,Item:item}));return value;
    } finally {await release();}
  }
  async function appendAudit(id,entry) {
    const key=`forward/${id}/${entry.type}-${entry.hash}.json`;
    await archive(key,entry);
    const Items=[{Put:{...base,Item:{pk:'audit#'+id,sk:entry.type==='freeze'?'event#0':'event#1',object_key:key,
      expires_epoch:Math.floor(now()/1000)+90*86400},ConditionExpression:'attribute_not_exists(pk)'}},
      {Update:{...base,Key:{pk:'audit#'+id,sk:'head'},UpdateExpression:'SET #last = :hash',
        ConditionExpression:entry.previous?'#last = :previous':'attribute_not_exists(#last)',
        ExpressionAttributeNames:{'#last':'last'},ExpressionAttributeValues:{':hash':entry.hash,...(entry.previous?{':previous':entry.previous}:{})}}}];
    if(entry.type==='freeze')Items.push({Put:{...base,Item:{pk:'forward',sk:entry.recorded_at+'#'+id,id,expires_epoch:Math.floor(now()/1000)+90*86400}}});
    await client.send(new TransactWriteCommand({TransactItems:Items}));
  }
  async function readAudit(id) {
    const r=await client.send(new QueryCommand({...base,KeyConditionExpression:'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues:{':pk':'audit#'+id,':prefix':'event#'},ConsistentRead:true,Limit:3}));
    return await Promise.all((r.Items||[]).map(async item=>{
      const object=await s3.send(new GetObjectCommand({Bucket:bucket,Key:item.object_key}));
      return JSON.parse(await object.Body.transformToString());
    }));
  }
  async function auditIds() {
    const r=await client.send(new QueryCommand({...base,KeyConditionExpression:'pk = :pk',ExpressionAttributeValues:{':pk':'forward'},
      ConsistentRead:true,ScanIndexForward:false,Limit:60}));
    return (r.Items||[]).map(i=>i.id);
  }
  async function journalRows(pk) {
    const r=await client.send(new QueryCommand({...base,KeyConditionExpression:'pk = :pk AND begins_with(sk,:prefix)',
      ExpressionAttributeValues:{':pk':pk,':prefix':'forecast#'},ConsistentRead:true,Limit:100}));
    return {items:r.Items||[],partial:Boolean(r.LastEvaluatedKey)};
  }
  async function pendingRows(now,limit) {
    const r=await client.send(new QueryCommand({...base,IndexName:'pending',KeyConditionExpression:'pending_pk = :pk AND pending_sk <= :now',
      ExpressionAttributeValues:{':pk':'pending',':now':now+'~'},Limit:limit}));
    return r.Items||[];
  }
  async function reschedule(row,next) {
    await client.send(new UpdateCommand({...base,Key:{pk:row.pk,sk:row.sk},UpdateExpression:'SET pending_sk = :next',
      ConditionExpression:'#status = :pending',ExpressionAttributeNames:{'#status':'status'},
      ExpressionAttributeValues:{':next':next,':pending':'pending'}}));
  }
  async function settle(row,score,asof) {
    await client.send(new UpdateCommand({...base,Key:{pk:row.pk,sk:row.sk},
      UpdateExpression:'SET #status = :settled, score = :score, settlement_as_of = :asof REMOVE pending_pk, pending_sk',
      ConditionExpression:'#status = :pending AND freeze_hash = :hash',ExpressionAttributeNames:{'#status':'status'},
      ExpressionAttributeValues:{':settled':'settled',':score':score,':asof':asof,':pending':'pending',':hash':row.freeze_hash}}));
  }
  return {kind:'dynamodb',get,put,consume,lease,archive,cached,appendAudit,readAudit,auditIds,journalRows,pendingRows,reschedule,settle,client,base};
}
