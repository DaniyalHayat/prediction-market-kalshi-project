import {BudgetsClient,DescribeBudgetCommand} from '@aws-sdk/client-budgets';
import {LambdaWebClient,UpdateWebFunctionEndpointCommand} from '@aws-sdk/client-lambda-web';
import {PutCommand} from '@aws-sdk/lib-dynamodb';
import {store} from '../lib/cloud/store.mjs';
import {settleDue} from '../lib/cloud/journal.mjs';
const budget=new BudgetsClient({region:'us-east-1',maxAttempts:2});
const web=new LambdaWebClient({region:process.env.AWS_REGION||'us-east-2',maxAttempts:2});
export async function setCostGate(cost,{storage=store(),endpoint=web,now=new Date()}={}) {
  const month=now.toISOString().slice(0,7);
  const disabled=cost===null||!Number.isFinite(cost)||cost>=8;
  const rate=disabled?0:100;
  await endpoint.send(new UpdateWebFunctionEndpointCommand({
    functionName:process.env.WEB_FUNCTION_NAME,endpointName:'public',throttleConfig:{rateLimit:rate}}));
  await storage.client.send(new PutCommand({...storage.base,Item:{pk:'config#cost',sk:'value',disabled,
    observed_cost:cost,month,observed_at:now.toISOString(),reason:cost===null?'budget_unavailable':disabled?'monthly_allowance':'within_allowance'}}));
  return disabled;
}
export async function handler(){
  const release=await store().lease('hourly-worker',90);
  if(!release)return {already_running:true};
  try{return await run();}finally{await release();}
}
async function run(){
  let b;
  try{b=await budget.send(new DescribeBudgetCommand({AccountId:process.env.ACCOUNT_ID,BudgetName:process.env.BUDGET_NAME}));}
  catch(error){await setCostGate(null);throw error;}
  const cost=Number(b.Budget?.CalculatedSpend?.ActualSpend?.Amount||0);
  if(await setCostGate(cost))return {disabled:true,observed_cost:cost};
  const result=await settleDue(6);return {checked:result.length,observed_cost:cost,result};
}
