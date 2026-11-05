import {isIP} from 'node:net';
import {open} from 'maxmind';
import {isCountryAllowed} from './geo.mjs';

let database;
export function azureClientIP(headers) {
  const candidate=headers.get('x-forwarded-for')?.split(',').at(-1)?.trim();
  return candidate&&isIP(candidate)?candidate:null;
}

async function lookupCountry(ip) {
  if(!process.env.AZURE_COUNTRY_DB)throw new Error('Azure country database unavailable');
  database??=open(process.env.AZURE_COUNTRY_DB);
  try{return (await database).get(ip)?.country?.iso_code??null;}
  catch(error){database=undefined;throw error;}
}

export async function azureAccess(headers,lookup=lookupCountry) {
  const ip=azureClientIP(headers);
  if(!ip)return {status:403};
  try{
    const country=await lookup(ip);
    return isCountryAllowed(country)?{status:200,ip,country}:{status:403};
  }catch{return {status:503};}
}
