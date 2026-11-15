import { render } from 'preact';
import { App } from './app';
import { startQueue } from './queue';
import './styles.css';

render(<App />, document.getElementById('app')!);
startQueue();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('service worker registration failed', e));
}
