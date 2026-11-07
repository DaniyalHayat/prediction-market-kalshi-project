import '../ui/workspace.css';
import '../ui/azure-replay.css';
import 'uplot/dist/uPlot.min.css';
import Analytics from './components/Analytics.jsx';
import type {ReactNode} from 'react';
import type {Metadata} from 'next';
import {azureMode} from '../lib/workspace/azure-mode.mjs';
import {headers} from 'next/headers';
export const metadata:Metadata = { title: "Predictir | Market research and paper trading", description: "Predictir is an independent market research and paper-trading app. Not affiliated with, endorsed by, or operated by the exchange providing market data. Predictir accounts are for this app only.", metadataBase:new URL('https://predictir.dev'), verification:{google:['FCoPfWp2NwEtKCMJq_AW6Cx2itHdrAZcG9PkS0PdpFQ','google7653305cfae6f81b']}, icons:{icon:[{url:'/favicon.ico',sizes:'any'},{url:'/favicon.svg',type:'image/svg+xml'}]} };
export default async function RootLayout({children}:{children:ReactNode}) {
  const nonce=(await headers()).get('x-nonce')||undefined;
  const edition=azureMode();
  return <html lang="en"><body style={{margin: 0}}>{children}
    {edition==='live'&&<footer className="azure-attribution"><a href="https://db-ip.com/">IP geolocation by DB-IP</a></footer>}
    {!edition&&<Analytics nonce={nonce}/>}</body></html>;
}
