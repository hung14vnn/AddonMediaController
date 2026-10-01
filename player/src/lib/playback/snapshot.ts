import type { Song } from '../types';
import type { Repeat } from './queue';

const QUEUE_KEY = 'music.queue';

/** Queue state kept in localStorage so a reload resumes where it left off. */
export interface QueueSnapshot {
	queue: Song[];
	index: number;
	time: number;
	shuffle: boolean;
	repeat: Repeat;
	unshuffled: Song[] | null;
}

/** The saved snapshot, normalised; null when there is none or it is corrupt. */
export function readSnapshot(): QueueSnapshot | null {
	try {
		const raw = localStorage.getItem(QUEUE_KEY);
		if (!raw) return null;
		const saved = JSON.parse(raw);
		const queue: Song[] = saved.queue ?? [];
		return {
			queue,
			index: Math.min(saved.index ?? -1, queue.length - 1),
			time: saved.time ?? 0,
			shuffle: !!saved.shuffle,
			repeat: saved.repeat ?? 'off',
			unshuffled: saved.unshuffled ?? null
		};
	} catch {
		return null;
	}
}

export function writeSnapshot(snapshot: QueueSnapshot) {
	try {
		localStorage.setItem(QUEUE_KEY, JSON.stringify(snapshot));
	} catch {
		/* storage full or unavailable */
	}
}

export function clearSnapshot() {
	try {
		localStorage.removeItem(QUEUE_KEY);
	} catch {
		/* ignore */
	}
}
