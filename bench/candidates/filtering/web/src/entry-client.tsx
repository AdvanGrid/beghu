import { render } from '@solidjs/web';
import { App } from './App';
import { clientSource } from './source-client';
import './app.css';

render(() => <App source={clientSource()} />, document.getElementById('root')!);
