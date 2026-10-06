/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

// Service worker (Workbox): network-first app shell (so updates land immediately when online),
// precached hashed assets and LRU-bounded caches for cover art, avatars and lyrics. Audio
// streams and list/search API calls are never cached here: streams use Range requests and
// list responses are per-user, change constantly and are revalidated by `cached()` in api.ts.
import { build, files, version } from '$service-worker';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';
import { clientsClaim } from 'workbox-core';
import { ExpirationPlugin } from 'workbox-expiration';
import * as navigationPreload from 'workbox-navigation-preload';
import { precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { CacheFirst, NetworkFirst } from 'workbox-strategies';

const sw = self as unknown as ServiceWorkerGlobalScope;

const NAV = 'nav-v1';
const ART = 'art-v1';
const ART_LIMIT = 600;
const AVATAR = 'avatar-v1';
const LYRICS = 'lyrics-v1';
const DAY = 24 * 60 * 60;

// `build`/`files` already include the base path; the shell is the scope root (hash routing).
const SHELL_URL = new URL('./', sw.registration.scope).href;

sw.skipWaiting();
clientsClaim();
// Lets the browser start fetching the shell while this worker is still booting.
navigationPreload.enable();

// Build output is content-hashed so it needs no revision; static files are keyed by the app
// version. Workbox diffs the manifest on update, so only changed entries are re-downloaded.
precacheAndRoute([
	...build.map((url) => ({ url, revision: null })),
	...files.filter((f) => !f.endsWith('/_headers')).map((url) => ({ url, revision: version }))
]);

// Warm the shell so the first offline launch after install works.
sw.addEventListener('install', (event) => {
	event.waitUntil(caches.open(NAV).then((c) => c.add(SHELL_URL)));
});

// Drop the `shell-<version>` caches left by the pre-Workbox worker.
sw.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k.startsWith('shell-')).map((k) => caches.delete(k))))
	);
});

const okOnly = () => new CacheableResponsePlugin({ statuses: [200] });

/** Cache key from a subset of query params: drops the per-session auth salt/token. */
function keyedBy(...params: string[]) {
	return {
		cacheKeyWillBeUsed: async ({ request }: { request: Request }) => {
			const url = new URL(request.url);
			const kept = params.map((p) => `${p}=${encodeURIComponent(url.searchParams.get(p) ?? '')}`);
			return `${url.origin}${url.pathname}?${kept.join('&')}`;
		}
	};
}

const rest = (endpoint: string) => (url: URL) => url.pathname.endsWith(`/rest/${endpoint}`);

// Cover URLs carry a per-session salt/token; key the cache on id+size only.
registerRoute(
	({ url }) => rest('getCoverArt')(url) && !url.searchParams.get('id')?.startsWith('pl-'),
	new CacheFirst({
		cacheName: ART,
		plugins: [
			keyedBy('id', 'size'),
			okOnly(),
			new ExpirationPlugin({ maxEntries: ART_LIMIT, maxAgeSeconds: 30 * DAY, purgeOnQuotaError: true })
		]
	})
);

registerRoute(
	({ url }) => rest('getAvatar')(url),
	new CacheFirst({
		cacheName: AVATAR,
		plugins: [keyedBy('username'), okOnly(), new ExpirationPlugin({ maxEntries: 5, maxAgeSeconds: DAY })]
	})
);

// Subsonic reports API errors inside a 200 JSON body; never cache those.
const subsonicOkOnly = {
	cacheWillUpdate: async ({ response }: { response: Response }) => {
		if (response.status !== 200) return null;
		try {
			const body = await response.clone().json();
			return body?.['subsonic-response']?.status === 'ok' ? response : null;
		} catch {
			return null;
		}
	}
};

// Plain lyrics for a given artist+title practically never change.
registerRoute(
	({ url }) => rest('getLyrics')(url),
	new CacheFirst({
		cacheName: LYRICS,
		plugins: [
			keyedBy('artist', 'title'),
			subsonicOkOnly,
			new ExpirationPlugin({ maxEntries: 300, maxAgeSeconds: 30 * DAY, purgeOnQuotaError: true })
		]
	})
);

// Every navigation is the shell (hash routing): fetch it fresh, fall back to the cached copy
// when offline or the network stalls.
registerRoute(
	new NavigationRoute(
		new NetworkFirst({
			cacheName: NAV,
			networkTimeoutSeconds: 3,
			plugins: [okOnly(), { cacheKeyWillBeUsed: async () => SHELL_URL }]
		}),
		{ denylist: [/\/rest\//] }
	)
);
