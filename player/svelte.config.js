import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
export default {
	preprocess: vitePreprocess(),
	kit: {
		// Plain static files in dist/, same as the old Vite build (Cloudflare Pages, /player/ sub-path, …).
		adapter: adapter({ pages: 'dist', assets: 'dist' }),
		// Hash-routed builds use absolute asset URLs; set PLAYER_BASE=/player to host under a sub-path.
		paths: { base: process.env.PLAYER_BASE ?? '' },
		// Hash routing works from any sub-path and needs no server rewrites, and keeps the
		// existing `#/album/…` links and installed-PWA bookmarks valid.
		router: { type: 'hash' },
		// Registered manually in +layout.svelte so it stays production-only.
		serviceWorker: { register: false }
	}
};
