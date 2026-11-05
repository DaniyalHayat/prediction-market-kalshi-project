import '../ui/workspace.css';
import '../ui/azure-replay.css';
import 'uplot/dist/uPlot.min.css';
import Analytics from './components/Analytics.jsx';
import {azureMode} from '../lib/workspace/azure-mode.mjs';
export const metadata = { title: "Predictir", description: "Public market research, source-backed analysis and paper trading", metadataBase:new URL('https://predictir.dev'), icons:{icon:[{url:'/favicon.ico',sizes:'any'},{url:'/favicon.svg',type:'image/svg+xml'}]} };
export default function RootLayout({ children }) {
  const edition=azureMode();
  return <html lang="en"><body style={{margin: 0}}>{children}
    {edition==='live'&&<footer className="azure-attribution"><a href="https://db-ip.com/">IP geolocation by DB-IP</a></footer>}
    {!edition&&<Analytics/>}</body></html>;
}
