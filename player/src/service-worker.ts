/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

// Service worker: network-first app shell (so updates land immediately when online),
// cache-first hashed assets and cover art. Audio streams and API calls are never cached:
// streams use Range requests and API responses are per-user and change constantly.
import { build, files, version } from '$service-worker';

const sw = self as unknown as ServiceWorkerGlobalScope;

const SHELL = `shell-${version}`;
const ART = 'art-v1';
const ART_LIMIT = 600;

// `build`/`files` already include the base path; the shell is the scope root (hash routing).
const SHELL_URL = new URL('./', sw.registration.scope).href;
const PRECACHE = [SHELL_URL, ...build, ...files.filter((f) => !f.endsWith('/_headers'))];

sw.addEventListener('install', (event) => {
	event.waitUntil(
		caches
			.open(SHELL)
			.then((c) => c.addAll(PRECACHE))
			.then(() => sw.skipWaiting())
	);
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== ART).map((k) => caches.delete(k))))
			.then(() => sw.clients.claim())
	);
});

async function trim(cacheName: string, max: number) {
	const cache = await caches.open(cacheName);
	const keys = await cache.keys();
	for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

// Cover URLs carry a per-session salt/token; key the cache on id+size only.
function artKey(url: URL) {
	return `${url.origin}${url.pathname}?id=${url.searchParams.get('id')}&size=${url.searchParams.get('size')}`;
}

sw.addEventListener('fetch', (event) => {
	const req = event.request;
	if (req.method !== 'GET') return;
	const url = new URL(req.url);

	if (url.pathname.endsWith('/rest/getCoverArt')) {
		if (url.searchParams.get('id')?.startsWith('pl-')) return;
		const key = artKey(url);
		event.respondWith(
			caches.open(ART).then(async (cache) => {
				const hit = await cache.match(key);
				if (hit) return hit;
				const res = await fetch(req);
				if (res.ok) {
					cache.put(key, res.clone());
					trim(ART, ART_LIMIT);
				}
				return res;
			})
		);
		return;
	}

	if (url.origin !== location.origin || url.pathname.includes('/rest/')) return;

	if (req.mode === 'navigate') {
		event.respondWith(
			fetch(req)
				.then((res) => {
					const copy = res.clone();
					caches.open(SHELL).then((c) => c.put(SHELL_URL, copy));
					return res;
				})
				.catch(async () => (await caches.match(SHELL_URL)) ?? Response.error())
		);
		return;
	}

	if (url.pathname.includes('/_app/immutable/') || /\.(png|svg|webmanifest)$/.test(url.pathname)) {
		event.respondWith(
			caches.match(req).then(
				(hit) =>
					hit ||
					fetch(req).then((res) => {
						if (res.ok) {
							const copy = res.clone();
							caches.open(SHELL).then((c) => c.put(req, copy));
						}
						return res;
					})
			)
		);
	}
});
