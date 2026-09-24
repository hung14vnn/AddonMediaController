import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Relative base so the build can be hosted at any sub-path (e.g. /player/).
// In dev, /subsonic is proxied to the DroppedNeedle backend so the default
// "same origin" server works without CORS setup.
const backend = process.env.PLAYER_BACKEND ?? 'http://localhost:8688';

export default defineConfig({
	base: './',
	plugins: [svelte()],
	server: {
		port: 5180,
		proxy: {
			'/subsonic': { target: backend, changeOrigin: true },
			'/rest': { target: backend, changeOrigin: true }
		}
	}
});
