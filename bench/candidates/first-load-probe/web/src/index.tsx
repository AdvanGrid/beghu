import { render } from '@solidjs/web';
import { App } from './App';
import { Router } from './router';
import './app.css';

render(() => <Router>{(props) => <App>{props.children}</App>}</Router>, document.getElementById('root')!);
