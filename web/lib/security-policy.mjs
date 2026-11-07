export function contentSecurityPolicy({nonce='',development=false}={}){
  const script=["'self'",...(nonce?["'nonce-"+nonce+"'","'strict-dynamic'"]:[]),
    ...(development?["'unsafe-inline'","'unsafe-eval'"]:[]),'https://www.googletagmanager.com'].join(' ');
  return ["default-src 'self'",'script-src '+script,"script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://is1-ssl.mzstatic.com https://is2-ssl.mzstatic.com https://is3-ssl.mzstatic.com https://is4-ssl.mzstatic.com https://www.google-analytics.com https://region1.google-analytics.com https://www.googletagmanager.com",
    "connect-src 'self' https://www.google-analytics.com https://region1.google-analytics.com https://analytics.google.com https://www.googletagmanager.com",
    "font-src 'self'","object-src 'none'","base-uri 'self'","form-action 'self'","frame-ancestors 'none'","frame-src 'none'",
    ...(!development?['upgrade-insecure-requests']:[])].join('; ');
}
