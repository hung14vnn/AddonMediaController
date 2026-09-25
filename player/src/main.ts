import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';

mount(App, { target: document.getElementById('app')! });

// Android may keep the orientation from the original PWA installation even
// after the manifest changes. Lock installed PWA windows to portrait as well.
if (matchMedia('(display-mode: standalone)').matches) {
	navigator.screen?.orientation?.lock('portrait').catch(() => {
		/* Orientation locking is not supported in every browser/context. */
	});
}

if ('serviceWorker' in navigator && import.meta.env.PROD) {
	addEventListener('load', () => {
		navigator.serviceWorker.register('./sw.js').catch(() => {
			/* offline support is optional */
		});
	});
}
