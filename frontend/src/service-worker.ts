import { base, build, files, version } from '$service-worker';

const CACHE_NAME = `hify-shell-${version}`;
const SHELL = [...build, ...files, `${base || ''}/`];

self.addEventListener('install', (event) => {
	event.waitUntil(
		caches.open(CACHE_NAME).then(async (cache) => {
			await Promise.allSettled(SHELL.map((asset) => cache.add(asset)));
			await self.skipWaiting();
		})
	);
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((names) =>
				Promise.all(
					names
						.filter((name) => name.startsWith('hify-shell-') && name !== CACHE_NAME)
						.map((name) => caches.delete(name))
				)
			)
			.then(() => self.clients.claim())
	);
});

self.addEventListener('fetch', (event) => {
	if (event.request.method !== 'GET') return;
	const requestUrl = new URL(event.request.url);
	if (requestUrl.origin !== self.location.origin) return;

	if (event.request.mode === 'navigate') {
		event.respondWith(
			fetch(event.request)
				.then((response) => {
					const copy = response.clone();
					void caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
					return response;
				})
				.catch(async () => {
					const cache = await caches.open(CACHE_NAME);
					return (
						(await cache.match(event.request)) ??
						(await cache.match(`${base || ''}/`)) ??
						(Response.error() as Response)
					);
				})
		);
		return;
	}

	if (
		event.request.destination === 'script' ||
		event.request.destination === 'style' ||
		event.request.destination === 'font' ||
		event.request.destination === 'image'
	) {
		event.respondWith(caches.match(event.request).then((cached) => cached ?? fetch(event.request)));
	}
});
