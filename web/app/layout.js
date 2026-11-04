import '../ui/workspace.css';
import 'uplot/dist/uPlot.min.css';
import Analytics from './components/Analytics.jsx';
export const metadata = { title: "Kalshi Market Lab", description: "Public market research, source-backed analysis and paper trading", metadataBase:new URL('https://predictir.dev') };
export default function RootLayout({ children }) { return <html lang="en"><body style={{margin: 0}}>{children}<Analytics/></body></html>; }
