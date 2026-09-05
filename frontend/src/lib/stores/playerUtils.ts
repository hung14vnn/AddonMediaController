import type { NowPlaying, QueueItem, QueueOrigin, SourceType } from '$lib/player/types';
import { playbackToast } from '$lib/stores/playbackToast.svelte';

const VOLUME_STORAGE_KEY = 'droppedneedle_player_volume';
const SESSION_STORAGE_KEY = 'droppedneedle_player_session';
const PROGRESS_STORAGE_KEY = `${SESSION_STORAGE_KEY}_progress`;
let checkpointId: string | null = null;

/** Save only the position; never traverse the queue on playback ticks. */
export function storeSessionProgress(progress: number): void {
	if (!checkpointId || !Number.isFinite(progress) || progress < 0) return;
	try {
		localStorage.setItem(PROGRESS_STORAGE_KEY, JSON.stringify({ checkpointId, progress }));
	} catch {
		// Session persistence is best effort.
	}
}

export type StoredSession = {
	nowPlaying: NowPlaying;
	queue: QueueItem[];
	currentIndex: number;
	progress: number;
	shuffleEnabled: boolean;
	shuffleOrder: number[];
};

export function shuffleArray(length: number): number[] {
	const arr = Array.from({ length }, (_, i) => i);
	for (let i = arr.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[arr[i], arr[j]] = [arr[j], arr[i]];
	}
	return arr;
}

export function stampOrigin(items: QueueItem[], origin: QueueOrigin): QueueItem[] {
	return items.map((item) => ({ ...item, queueOrigin: origin }));
}

export function stampSingleOrigin(item: QueueItem, origin: QueueOrigin): QueueItem {
	return { ...item, queueOrigin: origin };
}

export function normalizeSourceType(sourceType: SourceType | 'howler'): SourceType {
	return sourceType === 'howler' ? 'local' : sourceType;
}

export function migrateLegacyItem(
	item: QueueItem & { sourceType: SourceType | 'howler' }
): QueueItem {
	const sourceType = normalizeSourceType(item.sourceType);
	const availableSources = item.availableSources?.map((source) =>
		normalizeSourceType(source as SourceType | 'howler')
	);
	return {
		...item,
		sourceType,
		availableSources,
		queueOrigin: item.queueOrigin ?? 'context'
	};
}

// The listening room manages its queue inline, so its "added to queue" toasts are noise there.
let queueMutationToastsSuppressed = false;

export function setQueueMutationToastsSuppressed(suppressed: boolean): void {
	queueMutationToastsSuppressed = suppressed;
}

export function showQueueMutationToast(action: 'queue' | 'next', count: number): void {
	if (queueMutationToastsSuppressed) return;
	const label = count === 1 ? 'track' : 'tracks';
	if (action === 'queue') {
		playbackToast.show(
			count === 1 ? 'Added track to queue' : `Added ${count} ${label} to queue`,
			'info'
		);
		return;
	}
	playbackToast.show(
		count === 1 ? 'Queued track to play next' : `Queued ${count} ${label} to play next`,
		'info'
	);
}

export function getStoredVolume(): number {
	try {
		const stored = localStorage.getItem(VOLUME_STORAGE_KEY);
		if (stored !== null) return Math.max(0, Math.min(100, Number(stored)));
	} catch {
		/* empty */
	}
	return 75;
}

export function storeVolume(volume: number): void {
	try {
		localStorage.setItem(VOLUME_STORAGE_KEY, String(volume));
	} catch {
		/* empty */
	}
}

export function getStoredSession(): StoredSession | null {
	try {
		const stored = localStorage.getItem(SESSION_STORAGE_KEY);
		if (!stored) return null;
		const parsed = JSON.parse(stored);
		if (parsed && parsed.nowPlaying) {
			checkpointId = parsed.checkpointId ?? null;
			try {
				const position = JSON.parse(localStorage.getItem(PROGRESS_STORAGE_KEY) ?? 'null');
				if (
					checkpointId &&
					position?.checkpointId === checkpointId &&
					Number.isFinite(position.progress) &&
					position.progress >= 0
				) {
					parsed.progress = position.progress;
				}
			} catch {
				// A damaged checkpoint must not prevent restoring the queue.
			}
			return parsed as StoredSession;
		}
	} catch {
		/* empty */
	}
	return null;
}

export function storeSessionData(data: StoredSession | null): void {
	checkpointId = null;
	try {
		if (data) {
			const nextId = `${Date.now()}-${Math.random()}`;
			localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ ...data, checkpointId: nextId }));
			checkpointId = nextId;
		} else {
			localStorage.removeItem(SESSION_STORAGE_KEY);
		}
		localStorage.removeItem(PROGRESS_STORAGE_KEY);
	} catch {
		/* empty */
	}
}
