import { base, build, files, version } from '$service-worker';

const CACHE_NAME = `hify-shell-${version}`;
const SHELL = [...build, ...files, `${base || ''}/`];
const AUDIO_ROUTE = `${base && base !== '/' ? base.replace(/\/+$/, '') : ''}/__hify_audio_cache__/`;
const AUDIO_STORES = {
	playback: { database: 'hify-playback-audio-cache-v1', store: 'audio' },
	offline: { database: 'hify-offline-audio-v1', store: 'tracks' }
} as const;
const AUDIO_SERVICE_WORKER_VERSION = 1;

type AudioKind = keyof typeof AUDIO_STORES;

interface CachedAudioRequest {
	kind: AudioKind;
	key: string;
}

function parseCachedAudioRequest(url: URL): CachedAudioRequest | null {
	if (!url.pathname.startsWith(AUDIO_ROUTE)) return null;
	const remainder = url.pathname.slice(AUDIO_ROUTE.length);
	const separator = remainder.indexOf('/');
	if (separator <= 0 || separator === remainder.length - 1) return null;
	const kind = remainder.slice(0, separator);
	if (kind !== 'playback' && kind !== 'offline') return null;
	try {
		return {
			kind: kind as AudioKind,
			key: decodeURIComponent(remainder.slice(separator + 1))
		};
	} catch {
		return null;
	}
}

function readIndexedDbValue(database: string, store: string, key: string): Promise<unknown | null> {
	return new Promise((resolve, reject) => {
		let request: IDBOpenDBRequest;
		try {
			request = indexedDB.open(database);
		} catch (error) {
			reject(error);
			return;
		}
		request.onupgradeneeded = () => {
			if (!request.result.objectStoreNames.contains(store)) {
				request.result.createObjectStore(store);
			}
		};
		request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
		request.onblocked = () => reject(new Error('IndexedDB open was blocked'));
		request.onsuccess = () => {
			const databaseHandle = request.result;
			if (!databaseHandle.objectStoreNames.contains(store)) {
				databaseHandle.close();
				resolve(null);
				return;
			}
			let getRequest: IDBRequest;
			try {
				getRequest = databaseHandle.transaction(store, 'readonly').objectStore(store).get(key);
			} catch (error) {
				databaseHandle.close();
				reject(error);
				return;
			}
			getRequest.onerror = () => {
				databaseHandle.close();
				reject(getRequest.error ?? new Error('IndexedDB read failed'));
			};
			getRequest.onsuccess = () => {
				databaseHandle.close();
				resolve(getRequest.result ?? null);
			};
		};
	});
}

async function readCachedAudio(request: CachedAudioRequest): Promise<Blob | null> {
	const config = AUDIO_STORES[request.kind];
	const value = await readIndexedDbValue(config.database, config.store, request.key);
	if (request.kind === 'offline') {
		if (!value || typeof value !== 'object' || !('blob' in value)) return null;
		const blob = (value as { blob?: unknown }).blob;
		return blob instanceof Blob ? blob : null;
	}
	return value instanceof Blob ? value : null;
}

interface ByteRange {
	start: number;
	end: number;
}

function parseByteRange(value: string | null, size: number): ByteRange | null {
	if (!value) return null;
	if (!value.startsWith('bytes=') || value.slice(6).includes(',')) return null;
	const [startText, endText = ''] = value.slice(6).split('-', 2);
	if (startText === '') {
		const suffixLength = Number(endText);
		if (!Number.isInteger(suffixLength) || suffixLength <= 0) return null;
		return { start: Math.max(0, size - suffixLength), end: size - 1 };
	}
	const start = Number(startText);
	if (!Number.isInteger(start) || start < 0 || start >= size) return null;
	const requestedEnd = endText === '' ? size - 1 : Number(endText);
	if (!Number.isInteger(requestedEnd) || requestedEnd < start) return null;
	return { start, end: Math.min(requestedEnd, size - 1) };
}

function audioHeaders(blob: Blob): Headers {
	const headers = new Headers();
	headers.set('Accept-Ranges', 'bytes');
	headers.set('Content-Length', String(blob.size));
	headers.set('Content-Type', blob.type || 'audio/mp4');
	// IndexedDB is the canonical cache. Avoid a second browser HTTP cache copy
	// that could outlive the user's cache deletion.
	headers.set('Cache-Control', 'no-store');
	headers.set('X-Content-Type-Options', 'nosniff');
	return headers;
}

async function serveCachedAudio(request: Request, lookup: CachedAudioRequest): Promise<Response> {
	let blob: Blob | null;
	try {
		blob = await readCachedAudio(lookup);
	} catch {
		return new Response('Cached audio is unavailable', { status: 500 });
	}
	if (!blob || blob.size === 0) return new Response('Cached audio not found', { status: 404 });

	const rangeHeader = request.headers.get('range');
	const headers = audioHeaders(blob);
	if (!rangeHeader) {
		return new Response(request.method === 'HEAD' ? null : blob, { status: 200, headers });
	}

	const range = parseByteRange(rangeHeader, blob.size);
	if (!range) {
		const unsatisfied = new Headers(headers);
		unsatisfied.set('Content-Range', `bytes */${blob.size}`);
		unsatisfied.delete('Content-Length');
		return new Response(null, { status: 416, headers: unsatisfied });
	}

	const partial = blob.slice(range.start, range.end + 1, blob.type);
	const partialHeaders = audioHeaders(partial);
	partialHeaders.set('Content-Range', `bytes ${range.start}-${range.end}/${blob.size}`);
	return new Response(request.method === 'HEAD' ? null : partial, {
		status: 206,
		statusText: 'Partial Content',
		headers: partialHeaders
	});
}

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

self.addEventListener('message', (event) => {
	if (event.data?.type !== 'hify-audio-capability') return;
	event.ports[0]?.postMessage({
		type: 'hify-audio-capability',
		version: AUDIO_SERVICE_WORKER_VERSION
	});
});

self.addEventListener('fetch', (event) => {
	if (event.request.method !== 'GET' && event.request.method !== 'HEAD') return;
	const requestUrl = new URL(event.request.url);
	if (requestUrl.origin !== self.location.origin) return;

	const cachedAudio = parseCachedAudioRequest(requestUrl);
	if (cachedAudio) {
		event.respondWith(serveCachedAudio(event.request, cachedAudio));
		return;
	}

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
