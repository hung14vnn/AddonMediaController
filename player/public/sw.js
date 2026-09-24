// Service worker: network-first app shell (so updates land immediately when online),
// cache-first hashed assets and cover art. Audio streams and API calls are never cached:
// streams use Range requests and API responses are per-user and change constantly.
const VERSION = 'v1';
const SHELL = `shell-${VERSION}`;
const ART = `art-${VERSION}`;
const ART_LIMIT = 600;

self.addEventListener('install', (event) => {
	event.waitUntil(
		caches
			.open(SHELL)
			.then((c) => c.addAll(['./', './index.html', './manifest.webmanifest', './icon.svg']))
			.then(() => self.skipWaiting())
	);
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== ART).map((k) => caches.delete(k))))
			.then(() => self.clients.claim())
	);
});

async function trim(cacheName, max) {
	const cache = await caches.open(cacheName);
	const keys = await cache.keys();
	for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

// Cover URLs carry a per-session salt/token; key the cache on id+size only.
function artKey(url) {
	return `${url.origin}${url.pathname}?id=${url.searchParams.get('id')}&size=${url.searchParams.get('size')}`;
}

self.addEventListener('fetch', (event) => {
	const req = event.request;
	if (req.method !== 'GET') return;
	const url = new URL(req.url);

	if (url.pathname.endsWith('/rest/getCoverArt')) {
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
					caches.open(SHELL).then((c) => c.put('./index.html', copy));
					return res;
				})
				.catch(() => caches.match('./index.html'))
		);
		return;
	}

	if (url.pathname.includes('/assets/') || /\.(png|svg|webmanifest)$/.test(url.pathname)) {
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
