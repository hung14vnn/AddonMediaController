import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

// In dev, /subsonic is proxied to the DroppedNeedle backend so the default
// "same origin" server works without CORS setup.
const backend = process.env.PLAYER_BACKEND ?? 'http://localhost:8688';

export default defineConfig({
	plugins: [sveltekit()],
	test: {
		environment: 'jsdom',
		include: ['src/**/*.spec.ts'],
		// Player tests re-import the store per test (vi.resetModules); compiling it can
		// exceed the 5s default while other files run in parallel.
		testTimeout: 30_000
	},
	server: {
		port: 5180,
		proxy: {
			'/subsonic': { target: backend, changeOrigin: true },
			'/rest': { target: backend, changeOrigin: true }
		}
	}
});
