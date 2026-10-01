// Pure queue maths. The Player owns the reactive state and applies these results;
// nothing here touches audio, storage or the DOM, so it is unit-tested directly.

export type Repeat = 'off' | 'all' | 'one';

/**
 * Merge `b` into `a` spread evenly with a little jitter, keeping each list's own
 * order (ported from the main frontend's queueHelpers.interleaveEvenly).
 */
export function interleaveEvenly<T>(a: T[], b: T[], jitter = 0.8): T[] {
	const out: T[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length || j < b.length) {
		if (j >= b.length) {
			out.push(a[i++]);
			continue;
		}
		if (i >= a.length) {
			out.push(b[j++]);
			continue;
		}
		const progressA = (i + 0.5) / a.length;
		const progressB = (j + 0.5 + (Math.random() - 0.5) * jitter) / b.length;
		if (progressA <= progressB) out.push(a[i++]);
		else out.push(b[j++]);
	}
	return out;
}

export function shuffled<T>(items: T[]): T[] {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

export interface PlayOrder<T> {
	queue: T[];
	/** Original order to restore when shuffle is turned off; null when not shuffled. */
	unshuffled: T[] | null;
	/** Index in `queue` to start playing. */
	start: number;
	shuffle: boolean;
}

/**
 * Queue for playing `songs` from `start`. A shuffle request shuffles everything;
 * with shuffle already on, the tapped song plays first and the rest are shuffled,
 * like Apple Music.
 */
export function planPlayOrder<T>(
	songs: T[],
	start: number,
	shuffleOn: boolean,
	shuffleRequested: boolean
): PlayOrder<T> {
	if (shuffleRequested) {
		return { queue: shuffled(songs), unshuffled: [...songs], start: 0, shuffle: true };
	}
	if (shuffleOn) {
		const first = songs[start];
		const rest = shuffled(songs.filter((_, i) => i !== start));
		return { queue: [first, ...rest], unshuffled: [...songs], start: 0, shuffle: true };
	}
	return { queue: [...songs], unshuffled: null, start, shuffle: false };
}

/** Turn shuffle on around the current track: it stays first, the rest are shuffled. */
export function shuffleAround<T>(queue: T[], index: number): { queue: T[]; index: number } {
	const current = queue[index];
	if (current === undefined) return { queue, index };
	const rest = queue.filter((_, i) => i !== index);
	return { queue: [current, ...shuffled(rest)], index: 0 };
}

/** Index of `current` once the original order is back; -1 with no current track. */
export function indexAfterUnshuffle<T extends { id: string }>(original: T[], current: T | null): number {
	if (!current) return -1;
	return Math.max(0, original.findIndex((s) => s.id === current.id));
}

/** Remove `at` from `queue` in place; returns the new current index, or null if `at` is current. */
export function removeAt<T>(queue: T[], index: number, at: number): number | null {
	if (at === index) return null;
	queue.splice(at, 1);
	return at < index ? index - 1 : index;
}

/** Move an item within `queue` in place; returns the current track's new index. */
export function moveItem<T>(queue: T[], index: number, from: number, to: number): number {
	const [item] = queue.splice(from, 1);
	queue.splice(to, 0, item);
	if (from < index && to >= index) return index - 1;
	if (from > index && to <= index) return index + 1;
	return index;
}

/** Index `next()` moves to, or -1 at the end of the queue with repeat off. */
export function nextIndex(length: number, index: number, repeat: Repeat): number {
	if (index < length - 1) return index + 1;
	if (repeat === 'all' && length) return 0;
	return -1;
}

export function cycleRepeat(repeat: Repeat): Repeat {
	return repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off';
}
