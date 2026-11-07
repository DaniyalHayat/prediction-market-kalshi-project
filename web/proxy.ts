import {randomBytes} from 'node:crypto';
import {NextResponse} from 'next/server';
import type {NextRequest} from 'next/server';
import {contentSecurityPolicy} from './lib/security-policy.mjs';

export function proxy(request:NextRequest){
  const nonce=randomBytes(18).toString('base64');
  const policy=contentSecurityPolicy({nonce,development:process.env.NODE_ENV==='development'});
  const requestHeaders=new Headers(request.headers);
  requestHeaders.set('x-nonce',nonce);
  requestHeaders.set('Content-Security-Policy',policy);
  const response=NextResponse.next({request:{headers:requestHeaders}});
  response.headers.set('Content-Security-Policy',policy);
  response.headers.set('Cache-Control','private, no-store');
  return response;
}

export const config={matcher:['/((?!api|_next/static|_next/image|favicon.ico|.*\\.[^/]+$).*)']};
