import { render } from '@solidjs/web';
import { App } from './App';
import { serverSource } from './source-server';
import './app.css';

render(() => <App source={serverSource()} />, document.getElementById('root')!);
