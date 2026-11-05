import {createClient} from '@supabase/supabase-js';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

export async function setupOwner({email,password,url,key,apply=false,createAuthClient=createClient}={}){
  if(typeof email!=='string'||email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new Error('Set MARKET_OWNER_EMAIL in the private setup environment.');
  if(!apply)return {mode:'preview',operation:'Create the initial confirmed account without sending email',password_required_on_apply:true,application_signup_enabled:false,hosted_auth_signup_setting_requires_review:true};
  if(!url||!key||typeof password!=='string'||password.length<12||password.length>200)throw new Error('Supply backend credentials and a private password of 12 through 200 characters.');
  const client=createAuthClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
  const {error}=await client.auth.admin.createUser({email:email.trim().toLowerCase(),password,email_confirm:true});
  if(error)throw new Error('Account creation did not complete. Existing accounts are never overwritten by this setup command.');
  return {created:true,email_sent:false,password_logged:false,application_signup_enabled:false,hosted_auth_signup_setting_requires_review:true};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const result=await setupOwner({email:process.env.MARKET_OWNER_EMAIL,password:process.env.MARKET_OWNER_SETUP_PASSWORD,url:process.env.SUPABASE_URL,key:process.env.SUPABASE_SERVICE_ROLE_KEY,apply:process.argv.includes('--apply')});
  console.log(JSON.stringify(result));
}
