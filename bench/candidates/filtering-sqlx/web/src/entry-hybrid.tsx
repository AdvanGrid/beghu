import { render } from '@solidjs/web';
import { App } from './App';
import { hybridSource } from './source-hybrid';
import './app.css';

render(() => <App source={hybridSource()} />, document.getElementById('root')!);
