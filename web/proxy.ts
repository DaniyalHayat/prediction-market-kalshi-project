import {randomBytes} from 'node:crypto';
import {NextResponse} from 'next/server';
import type {NextRequest} from 'next/server';
import {contentSecurityPolicy} from './lib/security-policy.mjs';
import {shareAccessEnabled,shareCookieAuthorized,publicAccessPath,PRIVATE_HEADERS} from './lib/private-access.mjs';

export function proxy(request:NextRequest){
  const nonce=randomBytes(18).toString('base64');
  const policy=contentSecurityPolicy({nonce,development:process.env.NODE_ENV==='development'});
  const requestHeaders=new Headers(request.headers);
  requestHeaders.set('x-nonce',nonce);
  requestHeaders.set('Content-Security-Policy',policy);
  let response:NextResponse;
  if(shareAccessEnabled()&&!publicAccessPath(request.nextUrl.pathname)&&!shareCookieAuthorized(request.headers.get('cookie'))){
    response=request.nextUrl.pathname.startsWith('/api/')||request.nextUrl.pathname.startsWith('/_next/data/')
      ?NextResponse.json({error:'A private Predictir link is required.'},{status:401})
      :NextResponse.redirect(new URL('/access',request.url));
  }else response=NextResponse.next({request:{headers:requestHeaders}});
  if(shareAccessEnabled())for(const [name,value]of Object.entries(PRIVATE_HEADERS))response.headers.set(name,value);
  response.headers.set('Content-Security-Policy',policy);
  response.headers.set('Cache-Control','private, no-store');
  return response;
}

export const config={matcher:['/((?!_next/static|favicon.ico|favicon.svg).*)']};
