import Workspace from '../ui/App.jsx';
import ReplayWorkspace from '../ui/ReplayWorkspace.jsx';
import {azureMode} from '../lib/workspace/azure-mode.mjs';

export default function Home() {
  const mode = azureMode();
  return mode === 'replay' ? <ReplayWorkspace/> : <Workspace paperWorkspace={mode === 'live'}/>;
}
