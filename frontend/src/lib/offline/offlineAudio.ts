import { del, get, getMany, keys, set, createStore } from 'idb-keyval';
import { api } from '$lib/api/client';
import { API } from '$lib/constants';

const AUDIO_DB = createStore('hify-offline-audio-v1', 'tracks');
const METADATA_DB = createStore('hify-offline-audio-metadata-v1', 'tracks');

export interface OfflineTrackMetadata {
	userId: string;
	trackId: string;
	libraryTrackId?: string;
	title: string;
	artistName: string;
	albumName: string;
	albumId?: string;
	artistId?: string;
	coverUrl?: string | null;
	trackNumber?: number;
	discNumber?: number | null;
	format: string;
	durationSeconds?: number | null;
	sizeBytes: number;
	mimeType: string;
	sourceUrl: string;
	storedAt: number;
}

interface OfflineTrackRecord extends OfflineTrackMetadata {
	blob: Blob;
}

export interface OfflineTrackDownloadInput {
	userId: string;
	trackId: string;
	libraryTrackId?: string;
	sourceUrl: string;
	title: string;
	artistName: string;
	albumName: string;
	albumId?: string;
	artistId?: string;
	coverUrl?: string | null;
	trackNumber?: number;
	discNumber?: number | null;
	format: string;
	durationSeconds?: number | null;
	signal?: AbortSignal;
}

export class OfflineStorageError extends Error {
	readonly code: 'UNSUPPORTED' | 'QUOTA' | 'DOWNLOAD';

	constructor(code: OfflineStorageError['code'], message: string) {
		super(message);
		this.name = 'OfflineStorageError';
		this.code = code;
	}
}

function encodedKey(userId: string, trackId: string): string {
	return `${encodeURIComponent(userId)}::${encodeURIComponent(trackId)}`;
}

function userKeyPrefix(userId: string): string {
	return `${encodeURIComponent(userId)}::`;
}

function ensureSupported(): void {
	if (typeof indexedDB === 'undefined' || typeof Blob === 'undefined') {
		throw new OfflineStorageError('UNSUPPORTED', 'Offline audio is not supported by this browser.');
	}
}

function mediaType(format: string, responseType: string | null, blobType: string): string {
	if (responseType && responseType !== 'application/octet-stream') {
		return responseType.split(';', 1)[0]!.trim();
	}
	if (blobType) return blobType;
	const normalized = format.toLowerCase();
	if (normalized === 'mp3') return 'audio/mpeg';
	if (normalized === 'flac') return 'audio/flac';
	if (normalized === 'wav') return 'audio/wav';
	if (normalized === 'ogg' || normalized === 'vorbis') return 'audio/ogg';
	if (normalized === 'opus') return 'audio/opus';
	if (normalized === 'aac') return 'audio/aac';
	return 'audio/*';
}

export function isOfflineAudioSupported(): boolean {
	return typeof indexedDB !== 'undefined' && typeof Blob !== 'undefined';
}

export async function getOfflineTrackMetadata(
	userId: string,
	trackId: string
): Promise<OfflineTrackMetadata | null> {
	if (!isOfflineAudioSupported()) return null;
	return (await get<OfflineTrackMetadata>(encodedKey(userId, trackId), METADATA_DB)) ?? null;
}

export async function getOfflineTrackBlob(userId: string, trackId: string): Promise<Blob | null> {
	if (!isOfflineAudioSupported()) return null;
	const record = await get<OfflineTrackRecord>(encodedKey(userId, trackId), AUDIO_DB);
	return record?.blob ?? null;
}

export async function createOfflineTrackUrl(
	userId: string,
	trackId: string
): Promise<{ url: string; revoke: () => void; source: 'download' } | null> {
	const blob = await getOfflineTrackBlob(userId, trackId);
	if (!blob) return null;
	const url = URL.createObjectURL(blob);
	return { url, revoke: () => URL.revokeObjectURL(url), source: 'download' };
}

export async function listOfflineTrackMetadata(userId: string): Promise<OfflineTrackMetadata[]> {
	if (!isOfflineAudioSupported()) return [];
	const allKeys = (await keys<string>(METADATA_DB)).filter((key) =>
		key.startsWith(userKeyPrefix(userId))
	);
	const records = await getMany<OfflineTrackMetadata>(allKeys, METADATA_DB);
	return records.filter((record): record is OfflineTrackMetadata => Boolean(record));
}

export async function findInvalidOfflineTrackIds(userId: string): Promise<string[]> {
	const records = await listOfflineTrackMetadata(userId);
	const trackIds = [...new Set(records.map((record) => record.trackId))];
	const existingTrackIds = new Set<string>();
	const batchSize = 500;

	for (let offset = 0; offset < trackIds.length; offset += batchSize) {
		const batch = trackIds.slice(offset, offset + batchSize);
		const response = await api.global.post<{ existing_file_ids: string[] }>(
			API.library.trackExistence(),
			{ file_ids: batch }
		);
		for (const trackId of response.existing_file_ids) existingTrackIds.add(trackId);
	}

	return trackIds.filter((trackId) => !existingTrackIds.has(trackId));
}

export async function deleteOfflineTrack(userId: string, trackId: string): Promise<void> {
	if (!isOfflineAudioSupported()) return;
	const key = encodedKey(userId, trackId);
	await Promise.all([del(key, AUDIO_DB), del(key, METADATA_DB)]);
}

export async function deleteOfflineTracks(
	userId: string,
	trackIds: Iterable<string>
): Promise<number> {
	if (!isOfflineAudioSupported()) return 0;
	const uniqueTrackIds = [...new Set(trackIds)];
	await Promise.all(uniqueTrackIds.map((trackId) => deleteOfflineTrack(userId, trackId)));
	return uniqueTrackIds.length;
}

export async function deleteAllOfflineTracks(userId: string): Promise<number> {
	if (!isOfflineAudioSupported()) return 0;
	const prefix = userKeyPrefix(userId);
	const allKeys = new Set(
		[...(await keys(AUDIO_DB)), ...(await keys(METADATA_DB))].filter((key) =>
			String(key).startsWith(prefix)
		)
	);
	await Promise.all(
		[...allKeys].map((key) => Promise.all([del(key, AUDIO_DB), del(key, METADATA_DB)]))
	);
	return allKeys.size;
}

export async function downloadOfflineTrack(
	input: OfflineTrackDownloadInput
): Promise<OfflineTrackMetadata> {
	ensureSupported();
	const key = encodedKey(input.userId, input.trackId);
	let response: Response;
	try {
		response = await api.global.get<Response>(input.sourceUrl, {
			raw: true,
			signal: input.signal
		});
	} catch (error) {
		if (input.signal?.aborted) throw error;
		throw new OfflineStorageError('DOWNLOAD', 'The track could not be downloaded.');
	}

	if (!response.ok) {
		throw new OfflineStorageError(
			'DOWNLOAD',
			response.status === 401
				? 'Your session expired. Sign in again before downloading offline tracks.'
				: `The track could not be downloaded (HTTP ${response.status}).`
		);
	}

	const blob = await response.blob();
	const old = await getOfflineTrackMetadata(input.userId, input.trackId);
	const estimated = await navigator.storage?.estimate?.();
	const available = (estimated?.quota ?? 0) - (estimated?.usage ?? 0);
	const additionalBytes = Math.max(0, blob.size - (old?.sizeBytes ?? 0));
	if (available > 0 && additionalBytes > available) {
		throw new OfflineStorageError(
			'QUOTA',
			'Not enough device storage is available for this offline track.'
		);
	}

	const metadata: OfflineTrackMetadata = {
		userId: input.userId,
		trackId: input.trackId,
		libraryTrackId: input.libraryTrackId,
		title: input.title,
		artistName: input.artistName,
		albumName: input.albumName,
		albumId: input.albumId,
		artistId: input.artistId,
		coverUrl: input.coverUrl,
		trackNumber: input.trackNumber,
		discNumber: input.discNumber,
		format: input.format,
		durationSeconds: input.durationSeconds,
		sizeBytes: blob.size,
		mimeType: mediaType(input.format, response.headers.get('content-type'), blob.type),
		sourceUrl: input.sourceUrl,
		storedAt: Date.now()
	};
	const record: OfflineTrackRecord = { ...metadata, blob };

	try {
		await Promise.all([set(key, record, AUDIO_DB), set(key, metadata, METADATA_DB)]);
	} catch (error) {
		await Promise.allSettled([del(key, AUDIO_DB), del(key, METADATA_DB)]);
		if (error instanceof DOMException && error.name === 'QuotaExceededError') {
			throw new OfflineStorageError(
				'QUOTA',
				'Not enough device storage is available for this offline track.'
			);
		}
		throw error;
	}
	try {
		await navigator.storage?.persist?.();
	} catch {
		// Persistence is a best-effort hint; a denied request must not discard
		// a successful offline download.
	}

	return metadata;
}
