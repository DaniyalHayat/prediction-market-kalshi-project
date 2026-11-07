import '../ui/workspace.css';
import 'uplot/dist/uPlot.min.css';
import Analytics from './components/Analytics.jsx';
import {headers} from 'next/headers';
import {shareAccessEnabled,shareCookieAuthorized} from '../lib/private-access.mjs';
import PrivateWorkspaceControls from './components/PrivateWorkspaceControls';
export const metadata = { title: "Predictir | Market research and paper trading", description: "Predictir is an independent market research and paper-trading app. Not affiliated with, endorsed by, or operated by the exchange providing market data. Predictir accounts are for this app only.", metadataBase:new URL('https://predictir.dev'), verification:{google:['FCoPfWp2NwEtKCMJq_AW6Cx2itHdrAZcG9PkS0PdpFQ','google7653305cfae6f81b']}, icons:{icon:[{url:'/favicon.ico',sizes:'any'},{url:'/favicon.svg',type:'image/svg+xml'}]} };
metadata.robots={index:false,follow:false};
export default async function RootLayout({ children }) {
  const requestHeaders=await headers(),nonce=requestHeaders.get('x-nonce')||undefined;
  const privateAccess=shareAccessEnabled();
  return <html lang="en"><body style={{margin: 0}}>{children}{privateAccess&&shareCookieAuthorized(requestHeaders.get('cookie'))&&<PrivateWorkspaceControls/>}{!privateAccess&&<Analytics nonce={nonce}/>}</body></html>;
}
