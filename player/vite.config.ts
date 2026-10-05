import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

// In dev, /subsonic is proxied to the DroppedNeedle backend so the default
// "same origin" server works without CORS setup.
const backend = process.env.PLAYER_BACKEND ?? 'http://localhost:8688';

function git(args: string): string {
	try {
		return execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
	} catch {
		return '';
	}
}

/** Shown on the Account page and stamped into the playback log, to tell builds apart on a device. */
function buildInfo() {
	const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
	const commit = git('rev-parse --short HEAD') || 'unknown';
	const dirty = git('status --porcelain -- .') !== '';
	return { version, commit: dirty ? `${commit}-dirty` : commit, time: new Date().toISOString() };
}

export default defineConfig({
	plugins: [sveltekit()],
	define: {
		__BUILD__: JSON.stringify(buildInfo())
	},
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
