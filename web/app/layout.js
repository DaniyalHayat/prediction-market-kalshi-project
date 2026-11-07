import '../ui/workspace.css';
import 'uplot/dist/uPlot.min.css';
import Analytics from './components/Analytics.jsx';
import {headers} from 'next/headers';
export const metadata = { title: "Predictir | Market research and paper trading", description: "Predictir is an independent market research and paper-trading app. Not affiliated with, endorsed by, or operated by the exchange providing market data. Predictir accounts are for this app only.", metadataBase:new URL('https://predictir.dev'), verification:{google:['FCoPfWp2NwEtKCMJq_AW6Cx2itHdrAZcG9PkS0PdpFQ','google7653305cfae6f81b']}, icons:{icon:[{url:'/favicon.ico',sizes:'any'},{url:'/favicon.svg',type:'image/svg+xml'}]} };
export default async function RootLayout({ children }) {
  const nonce=(await headers()).get('x-nonce')||undefined;
  return <html lang="en"><body style={{margin: 0}}>{children}<Analytics nonce={nonce}/></body></html>;
}
