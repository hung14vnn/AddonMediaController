import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// In dev, /subsonic is proxied to the DroppedNeedle backend so the default
// "same origin" server works without CORS setup.
const backend = process.env.PLAYER_BACKEND ?? 'http://localhost:8688';

export default defineConfig({
	plugins: [sveltekit()],
	server: {
		port: 5180,
		proxy: {
			'/subsonic': { target: backend, changeOrigin: true },
			'/rest': { target: backend, changeOrigin: true }
		}
	}
});
