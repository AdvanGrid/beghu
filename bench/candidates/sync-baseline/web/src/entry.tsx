import { render } from '@solidjs/web';
import { App } from './App';
import { syncSource } from './source';
import './app.css';

render(() => <App source={syncSource()} />, document.getElementById('root')!);
