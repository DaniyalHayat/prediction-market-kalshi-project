const development=process.env.NODE_ENV==='development';
const policy=["default-src 'self'",`script-src 'self' 'unsafe-inline'${development?" 'unsafe-eval'":''} https://www.googletagmanager.com`,
  "style-src 'self' 'unsafe-inline'","img-src 'self' data: https://is1-ssl.mzstatic.com https://is2-ssl.mzstatic.com https://is3-ssl.mzstatic.com https://is4-ssl.mzstatic.com https://www.google-analytics.com https://region1.google-analytics.com https://www.googletagmanager.com",
  "connect-src 'self' https://www.google-analytics.com https://region1.google-analytics.com https://analytics.google.com https://www.googletagmanager.com",
  "font-src 'self'","object-src 'none'","base-uri 'self'","form-action 'self'","frame-ancestors 'none'","frame-src 'none'",
  ...(!development?['upgrade-insecure-requests']:[])].join('; ');
export default {output:'standalone',poweredByHeader:false,async headers(){return [{source:'/:path*',headers:[
  {key:'Content-Security-Policy',value:policy},{key:'X-Content-Type-Options',value:'nosniff'},
  {key:'Referrer-Policy',value:'strict-origin-when-cross-origin'},{key:'X-Frame-Options',value:'DENY'},
  {key:'Strict-Transport-Security',value:'max-age=31536000; includeSubDomains'},
  {key:'Permissions-Policy',value:'camera=(), microphone=(), geolocation=()'}]}];}};
