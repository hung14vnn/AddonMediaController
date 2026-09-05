import { withBasePath } from './basePath';

export type ServiceWorkerAudioKind = 'playback' | 'offline';

const AUDIO_ROUTE = '/__hify_audio_cache__';
const SERVICE_WORKER_WAIT_MS = 1000;
const AUDIO_SERVICE_WORKER_VERSION = 1;
const AUDIO_CAPABILITY_TIMEOUT_MS = 500;

let capabilityController: ServiceWorker | null = null;
let capabilityPromise: Promise<boolean> | null = null;

/**
 * Return a same-origin URL that the audio Service Worker can serve from the
 * existing IndexedDB Blob. This path is limited to iOS, where the Blob-media
 * path is the suspected source of extra playback work. A Blob URL remains the
 * fallback when the current page is not controlled yet (for example during the
 * first SW install).
 */
export async function createServiceWorkerAudioUrl(
	kind: ServiceWorkerAudioKind,
	key: string
): Promise<string | null> {
	if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
	if (!isIosDevice()) return null;

	const serviceWorker = navigator.serviceWorker;
	if (serviceWorker.controller && (await supportsAudioRoute(serviceWorker.controller))) {
		return buildAudioUrl(kind, key);
	}

	const registration = await serviceWorker.getRegistration().catch(() => undefined);
	if (!registration?.active) return null;

	// During installation, clients.claim() may set controller shortly after the
	// registration becomes active. Wait briefly for controllerchange so the first
	// playback can use the range-backed path without hanging if it never arrives.
	await new Promise<void>((resolve) => {
		let settled = false;
		const listenerAbort = new AbortController();
		const finish = () => {
			if (settled) return;
			settled = true;
			listenerAbort.abort();
			resolve();
		};
		const timeout = setTimeout(finish, SERVICE_WORKER_WAIT_MS);
		const onControllerChange = () => {
			clearTimeout(timeout);
			finish();
		};
		serviceWorker.addEventListener('controllerchange', onControllerChange, {
			once: true,
			signal: listenerAbort.signal
		});
	});
	if (!serviceWorker.controller) return null;
	if (!(await supportsAudioRoute(serviceWorker.controller))) return null;
	return buildAudioUrl(kind, key);
}

function supportsAudioRoute(controller: ServiceWorker): Promise<boolean> {
	if (controller === capabilityController && capabilityPromise) return capabilityPromise;
	capabilityController = controller;
	if (typeof MessageChannel === 'undefined') {
		capabilityPromise = Promise.resolve(false);
		return capabilityPromise;
	}

	capabilityPromise = new Promise<boolean>((resolve) => {
		const channel = new MessageChannel();
		let settled = false;
		const finish = (supported: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			channel.port1.close();
			resolve(supported);
		};
		const timeout = setTimeout(() => finish(false), AUDIO_CAPABILITY_TIMEOUT_MS);
		channel.port1.onmessage = (event) => {
			finish(
				event.data?.type === 'hify-audio-capability' &&
					event.data?.version === AUDIO_SERVICE_WORKER_VERSION
			);
		};
		try {
			controller.postMessage(
				{ type: 'hify-audio-capability', version: AUDIO_SERVICE_WORKER_VERSION },
				[channel.port2]
			);
		} catch {
			finish(false);
		}
	});
	return capabilityPromise;
}

function isIosDevice(): boolean {
	const userAgent = navigator.userAgent;
	return (
		/iPhone|iPad|iPod/.test(userAgent) ||
		(/Macintosh/.test(userAgent) && navigator.maxTouchPoints > 1)
	);
}

function buildAudioUrl(kind: ServiceWorkerAudioKind, key: string): string {
	const path = `${withBasePath(`${AUDIO_ROUTE}/${kind}`)}/${encodeURIComponent(key)}`;
	// Keep the URL absolute so getApiUrl() does not prepend PUBLIC_API_URL when
	// the API is deployed on a different origin.
	return typeof window === 'undefined' ? path : new URL(path, window.location.origin).href;
}
