import { del, get, getMany, keys, set, createStore } from 'idb-keyval';
import { getSession, streamUrl } from './api';
import type { Song } from './types';

const AUDIO_DB = createStore('player-offline-audio-v1', 'tracks');
const METADATA_DB = createStore('player-offline-audio-metadata-v1', 'tracks');

export interface OfflineTrackMetadata {
	userId: string;
	trackId: string;
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
	storedAt: number;
}

interface OfflineTrackRecord extends OfflineTrackMetadata {
	blob: Blob;
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

export function isOfflineAudioSupported(): boolean {
	return typeof indexedDB !== 'undefined' && typeof Blob !== 'undefined';
}

function ensureSupported(): void {
	if (!isOfflineAudioSupported()) {
		throw new OfflineStorageError('UNSUPPORTED', 'Offline audio is not supported by this browser.');
	}
}

export async function getOfflineTrackMetadata(userId: string, trackId: string): Promise<OfflineTrackMetadata | null> {
	if (!isOfflineAudioSupported()) return null;
	return (await get<OfflineTrackMetadata>(encodedKey(userId, trackId), METADATA_DB)) ?? null;
}

export async function getOfflineTrackBlob(userId: string, trackId: string): Promise<Blob | null> {
	if (!isOfflineAudioSupported()) return null;
	const record = await get<OfflineTrackRecord>(encodedKey(userId, trackId), AUDIO_DB);
	return record?.blob ?? null;
}

export async function createOfflineTrackUrl(userId: string, trackId: string): Promise<{ url: string; revoke: () => void } | null> {
	const blob = await getOfflineTrackBlob(userId, trackId);
	if (!blob) return null;
	const url = URL.createObjectURL(blob);
	return { url, revoke: () => URL.revokeObjectURL(url) };
}

export async function listOfflineTrackMetadata(userId: string): Promise<OfflineTrackMetadata[]> {
	if (!isOfflineAudioSupported()) return [];
	const allKeys = (await keys<string>(METADATA_DB)).filter((key) => key.startsWith(userKeyPrefix(userId)));
	const records = await getMany<OfflineTrackMetadata>(allKeys, METADATA_DB);
	return records.filter((record): record is OfflineTrackMetadata => Boolean(record)).sort((a, b) => b.storedAt - a.storedAt);
}

export async function deleteOfflineTrack(userId: string, trackId: string): Promise<void> {
	if (!isOfflineAudioSupported()) return;
	const key = encodedKey(userId, trackId);
	await Promise.all([del(key, AUDIO_DB), del(key, METADATA_DB)]);
}

export async function deleteAllOfflineTracks(userId: string): Promise<number> {
	if (!isOfflineAudioSupported()) return 0;
	const prefix = userKeyPrefix(userId);
	const allKeys = new Set(
		[...(await keys(AUDIO_DB)), ...(await keys(METADATA_DB))].filter((key) => String(key).startsWith(prefix))
	);
	await Promise.all([...allKeys].map((key) => Promise.all([del(key, AUDIO_DB), del(key, METADATA_DB)])));
	return allKeys.size;
}

export async function downloadOfflineTrack(song: Song): Promise<OfflineTrackMetadata> {
	ensureSupported();
	const session = getSession();
	if (!session?.username) throw new OfflineStorageError('DOWNLOAD', 'Not signed in');
	
	const userId = session.username;
	const url = streamUrl(song.id);
	const key = encodedKey(userId, song.id);

	let response: Response;
	try {
		response = await fetch(url);
	} catch (error) {
		throw new OfflineStorageError('DOWNLOAD', 'The track could not be downloaded.');
	}

	if (!response.ok) {
		throw new OfflineStorageError('DOWNLOAD', `The track could not be downloaded (HTTP ${response.status}).`);
	}

	const blob = await response.blob();
	const old = await getOfflineTrackMetadata(userId, song.id);
	const estimated = await navigator.storage?.estimate?.();
	const available = (estimated?.quota ?? 0) - (estimated?.usage ?? 0);
	const additionalBytes = Math.max(0, blob.size - (old?.sizeBytes ?? 0));
	
	if (available > 0 && additionalBytes > available) {
		throw new OfflineStorageError('QUOTA', 'Not enough device storage is available for this offline track.');
	}

	const metadata: OfflineTrackMetadata = {
		userId,
		trackId: song.id,
		title: song.title,
		artistName: song.artist ?? 'Unknown Artist',
		albumName: song.album ?? 'Unknown Album',
		albumId: song.albumId,
		artistId: song.artistId,
		coverUrl: song.coverArt,
		trackNumber: song.track,
		discNumber: song.discNumber,
		format: song.suffix ?? 'mp3',
		durationSeconds: song.duration,
		sizeBytes: blob.size,
		mimeType: blob.type || 'audio/mpeg',
		storedAt: Date.now()
	};
	
	const record: OfflineTrackRecord = { ...metadata, blob };

	try {
		await Promise.all([set(key, record, AUDIO_DB), set(key, metadata, METADATA_DB)]);
	} catch (error) {
		await Promise.allSettled([del(key, AUDIO_DB), del(key, METADATA_DB)]);
		if (error instanceof DOMException && error.name === 'QuotaExceededError') {
			throw new OfflineStorageError('QUOTA', 'Not enough device storage is available for this offline track.');
		}
		throw error;
	}
	try {
		await navigator.storage?.persist?.();
	} catch {
		// Persistence is best effort
	}

	return metadata;
}
