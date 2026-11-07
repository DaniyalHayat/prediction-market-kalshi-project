import {contentSecurityPolicy} from './lib/security-policy.mjs';
const policy=contentSecurityPolicy({development:process.env.NODE_ENV==='development'});
export default {output:'standalone',poweredByHeader:false,
  async redirects(){return ['/dashboard','/dashboard/index.html'].map(source=>({source,destination:'/',permanent:false}));},
  async headers(){return [{source:'/:path*',headers:[
  {key:'Content-Security-Policy',value:policy},{key:'X-Content-Type-Options',value:'nosniff'},
  {key:'Referrer-Policy',value:'no-referrer'},{key:'X-Frame-Options',value:'DENY'},
  {key:'X-Robots-Tag',value:'noindex, nofollow, noarchive, nosnippet, noimageindex'},
  {key:'Strict-Transport-Security',value:'max-age=31536000; includeSubDomains'},
  {key:'Cross-Origin-Opener-Policy',value:'same-origin'},
  {key:'Permissions-Policy',value:'camera=(), microphone=(), geolocation=()'}]}];}};
