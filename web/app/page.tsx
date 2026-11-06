import Workspace from '../ui/App';
import ReplayWorkspace from '../ui/ReplayWorkspace';
import {azureMode} from '../lib/workspace/azure-mode.mjs';

export default function Home() {
  const mode = azureMode();
  return mode === 'replay' ? <ReplayWorkspace/> : <Workspace paperWorkspace={mode === 'live'}/>;
}
