import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';

mount(App, { target: document.getElementById('app')! });

if ('serviceWorker' in navigator && import.meta.env.PROD) {
	addEventListener('load', () => {
		navigator.serviceWorker.register('./sw.js').catch(() => {
			/* offline support is optional */
		});
	});
}
