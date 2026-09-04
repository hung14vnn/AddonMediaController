import { createStore, del, get, getMany, keys, set } from 'idb-keyval';
import { api } from '$lib/api/client';

const AUDIO_DB = createStore('hify-playback-audio-cache-v1', 'audio');
const METADATA_DB = createStore('hify-playback-audio-cache-metadata-v1', 'tracks');

export const PLAYBACK_CACHE_MAX_BYTES = 256 * 1024 * 1024;
export const PLAYBACK_CACHE_MAX_TRACKS = 25;
export const PLAYBACK_CACHE_MAX_TRACK_BYTES = 64 * 1024 * 1024;

export interface PlaybackCacheInput {
	userId: string;
	trackId: string;
	sourceUrl: string;
	format?: string;
}

interface PlaybackCacheMetadata extends PlaybackCacheInput {
	sizeBytes: number;
	mimeType: string;
	storedAt: number;
	lastAccessedAt: number;
}

interface ActiveDownload {
	promise: Promise<PlaybackCacheMetadata | null>;
	controller: AbortController;
}

const downloads = new Map<string, ActiveDownload>();

function encodedKey(userId: string, trackId: string): string {
	return `${encodeURIComponent(userId)}::${encodeURIComponent(trackId)}`;
}

function supported(): boolean {
	return typeof indexedDB !== 'undefined' && typeof Blob !== 'undefined';
}

function mimeType(
	format: string | undefined,
	responseType: string | null,
	blobType: string
): string {
	if (responseType && responseType !== 'application/octet-stream') {
		return responseType.split(';', 1)[0]!.trim();
	}
	if (blobType) return blobType;
	switch (format?.toLowerCase()) {
		case 'mp3':
			return 'audio/mpeg';
		case 'm4a':
		case 'mp4':
		case 'alac':
			return 'audio/mp4';
		case 'aac':
			return 'audio/aac';
		case 'flac':
			return 'audio/flac';
		case 'ogg':
		case 'vorbis':
			return 'audio/ogg';
		case 'opus':
			return 'audio/opus';
		case 'wav':
			return 'audio/wav';
		default:
			return 'audio/*';
	}
}

async function allMetadata(): Promise<Array<{ key: string; value: PlaybackCacheMetadata }>> {
	const allKeys = await keys<string>(METADATA_DB);
	const values = await getMany<PlaybackCacheMetadata>(allKeys, METADATA_DB);
	return allKeys.flatMap((key, index) => {
		const value = values[index];
		return value ? [{ key, value }] : [];
	});
}

async function removeEntry(key: string): Promise<void> {
	await Promise.allSettled([del(key, AUDIO_DB), del(key, METADATA_DB)]);
}

async function makeRoom(key: string, sizeBytes: number): Promise<boolean> {
	const entries = await allMetadata();
	const old = entries.find((entry) => entry.key === key)?.value;
	const candidates = entries
		.filter((entry) => entry.key !== key)
		.sort((a, b) => a.value.lastAccessedAt - b.value.lastAccessedAt);
	let totalBytes = entries.reduce((sum, entry) => sum + entry.value.sizeBytes, 0);
	let totalTracks = entries.length;
	let freedBytes = 0;
	const additionalBytes = Math.max(0, sizeBytes - (old?.sizeBytes ?? 0));

	while (
		candidates.length > 0 &&
		(totalBytes - (old?.sizeBytes ?? 0) + sizeBytes > PLAYBACK_CACHE_MAX_BYTES ||
			totalTracks - (old ? 1 : 0) + 1 > PLAYBACK_CACHE_MAX_TRACKS)
	) {
		const victim = candidates.shift()!;
		await removeEntry(victim.key);
		totalBytes -= victim.value.sizeBytes;
		totalTracks--;
		freedBytes += victim.value.sizeBytes;
	}

	if (
		totalBytes - (old?.sizeBytes ?? 0) + sizeBytes > PLAYBACK_CACHE_MAX_BYTES ||
		totalTracks - (old ? 1 : 0) + 1 > PLAYBACK_CACHE_MAX_TRACKS
	) {
		return false;
	}

	try {
		const estimate = await navigator.storage?.estimate?.();
		if (estimate?.quota && estimate.usage !== undefined) {
			const availableBytes = Math.max(0, estimate.quota - estimate.usage) + freedBytes;
			if (additionalBytes > availableBytes) return false;
		}
	} catch {
		// Storage estimates are advisory and unavailable in some WebKit versions.
	}
	return true;
}

async function readValidEntry(input: PlaybackCacheInput): Promise<PlaybackCacheMetadata | null> {
	const key = encodedKey(input.userId, input.trackId);
	const metadata = await get<PlaybackCacheMetadata>(key, METADATA_DB);
	if (!metadata) return null;
	if (metadata.sourceUrl !== input.sourceUrl) {
		await removeEntry(key);
		return null;
	}
	const blob = await get<Blob>(key, AUDIO_DB);
	if (!blob) {
		await removeEntry(key);
		return null;
	}
	return metadata;
}

async function download(
	input: PlaybackCacheInput,
	controller: AbortController
): Promise<PlaybackCacheMetadata | null> {
	const key = encodedKey(input.userId, input.trackId);
	const timeout = setTimeout(() => controller.abort(), 30_000);
	try {
		const existing = await readValidEntry(input);
		if (existing) return existing;

		const response = await api.global.get<Response>(input.sourceUrl, {
			raw: true,
			cache: 'no-store',
			signal: controller.signal
		});
		if (!response.ok || response.status === 206 || response.headers.has('content-range'))
			return null;

		const declaredSize = Number(response.headers.get('content-length'));
		if (Number.isFinite(declaredSize) && declaredSize > PLAYBACK_CACHE_MAX_TRACK_BYTES) {
			await response.body?.cancel().catch(() => undefined);
			return null;
		}

		const blob = await response.blob();
		if (blob.size === 0 || blob.size > PLAYBACK_CACHE_MAX_TRACK_BYTES) return null;
		if (!(await makeRoom(key, blob.size))) return null;

		const now = Date.now();
		const metadata: PlaybackCacheMetadata = {
			...input,
			sizeBytes: blob.size,
			mimeType: mimeType(input.format, response.headers.get('content-type'), blob.type),
			storedAt: now,
			lastAccessedAt: now
		};
		const typedBlob = blob.type ? blob : blob.slice(0, blob.size, metadata.mimeType);
		try {
			await set(key, typedBlob, AUDIO_DB);
			await set(key, metadata, METADATA_DB);
		} catch {
			await removeEntry(key);
			return null;
		}
		return metadata;
	} catch {
		return null;
	} finally {
		clearTimeout(timeout);
	}
}

/** Download a local track into the disposable playback cache. Concurrent callers share one request. */
export async function cachePlaybackTrack(input: PlaybackCacheInput): Promise<boolean> {
	if (!supported()) return false;
	const key = encodedKey(input.userId, input.trackId);
	const active = downloads.get(key);
	if (active) return (await active.promise) !== null;
	const controller = new AbortController();
	const task = download(input, controller).finally(() => downloads.delete(key));
	downloads.set(key, { promise: task, controller });
	return (await task) !== null;
}

/** Return an object URL, downloading the complete track first when it is not cached yet. */
export async function createPlaybackTrackUrl(
	input: PlaybackCacheInput
): Promise<{ url: string; revoke: () => void; source: 'cache' } | null> {
	if (!supported()) return null;
	let metadata = await readValidEntry(input).catch(() => null);
	if (!metadata) {
		if (!(await cachePlaybackTrack(input))) return null;
		metadata = await readValidEntry(input).catch(() => null);
	}
	if (!metadata) return null;

	const key = encodedKey(input.userId, input.trackId);
	const blob = await get<Blob>(key, AUDIO_DB);
	if (!blob) {
		await removeEntry(key);
		return null;
	}
	await set(key, { ...metadata, lastAccessedAt: Date.now() }, METADATA_DB).catch(() => undefined);
	const url = URL.createObjectURL(blob);
	return { url, revoke: () => URL.revokeObjectURL(url), source: 'cache' };
}

export async function deletePlaybackTracks(
	userId: string,
	trackIds: Iterable<string>
): Promise<number> {
	if (!supported()) return 0;
	const uniqueTrackIds = [...new Set(trackIds)];
	await Promise.all(
		uniqueTrackIds.map(async (trackId) => {
			const key = encodedKey(userId, trackId);
			// Stop an in-flight pre-download before deleting so it cannot recreate
			// the cache after library removal.
			const active = downloads.get(key);
			active?.controller.abort();
			await active?.promise.catch(() => undefined);
			await removeEntry(key);
		})
	);
	return uniqueTrackIds.length;
}

export async function clearPlaybackCache(): Promise<void> {
	if (!supported()) return;
	const activeDownloads = [...downloads.values()];
	for (const active of activeDownloads) active.controller.abort();
	await Promise.allSettled(activeDownloads.map((active) => active.promise));
	const allKeys = new Set([...(await keys(AUDIO_DB)), ...(await keys(METADATA_DB))]);
	await Promise.all([...allKeys].map((key) => removeEntry(String(key))));
}
