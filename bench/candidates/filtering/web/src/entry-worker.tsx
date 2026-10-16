import { render } from '@solidjs/web';
import { App } from './App';
import { workerSource } from './source-worker';
import './app.css';

render(() => <App source={workerSource()} />, document.getElementById('root')!);
