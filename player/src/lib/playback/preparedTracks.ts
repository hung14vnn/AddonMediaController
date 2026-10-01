import type { Song } from '../types';

interface ObjectUrl {
	url: string;
	revoke: () => void;
}

/** Long mixes/podcasts stay streamed rather than held in memory whole. */
export const PREFETCH_MAX_DURATION_S = 20 * 60;

/**
 * Blob URLs for tracks that can start without the network: a downloaded copy from
 * IndexedDB, or the upcoming track fetched into memory while the current one plays.
 * Also owns the URL of the track now playing so it is revoked on the next change.
 */
export class PreparedTracks {
	private ready = new Map<string, ObjectUrl>();
	private pending = new Set<string>();
	/** Upcoming track already prefetched (or tried) during this track; one attempt each. */
	private prefetchedFor: string | null = null;
	private playing: ObjectUrl | null = null;

	/** A new track started loading: its successor gets a fresh prefetch attempt. */
	startTrack() {
		this.prefetchedFor = null;
	}

	/** Hand over the ready URL for `id`, which becomes the playing one; null if none. */
	take(id: string): string | null {
		const prepared = this.ready.get(id);
		if (!prepared) return null;
		this.ready.delete(id);
		this.adopt(prepared);
		return prepared.url;
	}

	/** Make `handle` the playing URL, releasing the previous one. */
	adopt(handle: ObjectUrl) {
		this.releasePlaying();
		this.playing = handle;
	}

	releasePlaying() {
		this.playing?.revoke();
		this.playing = null;
	}

	/** The downloaded copy of `id`, if the signed-in user has one. */
	async lookupOffline(id: string): Promise<ObjectUrl | null> {
		const { getSession } = await import('../api');
		const session = getSession();
		if (!session?.username) return null;
		try {
			const { createOfflineTrackUrl } = await import('../offline');
			return await createOfflineTrackUrl(session.username, id);
		} catch {
			return null;
		}
	}

	/** Resolve a downloaded copy of `song` ahead of time; kept only if still wanted. */
	prepareOffline(song: Song, stillWanted: () => boolean) {
		if (this.ready.has(song.id) || this.pending.has(song.id)) return;
		this.pending.add(song.id);
		void this.lookupOffline(song.id)
			.then((offline) => {
				if (!offline) return;
				if (stillWanted()) this.ready.set(song.id, offline);
				else offline.revoke();
			})
			.catch(() => {
				// Streaming remains the fallback.
			})
			.finally(() => this.pending.delete(song.id));
	}

	/**
	 * Download `song` into memory so the `ended` hand-off needs no network. A
	 * downloaded copy found by prepareOffline() wins and skips this.
	 */
	prefetch(song: Song, src: string, stillWanted: () => boolean) {
		if (this.prefetchedFor === song.id) return;
		if (this.ready.has(song.id) || this.pending.has(song.id)) return;
		if ((song.duration ?? 0) > PREFETCH_MAX_DURATION_S) return;
		if (!src) return;
		// timeupdate fires ~4×/s: a failed fetch must not be retried on every tick.
		this.prefetchedFor = song.id;
		this.pending.add(song.id);
		void fetch(src)
			.then((res) => (res.ok ? res.blob() : null))
			.then((blob) => {
				if (!blob || !stillWanted()) return;
				// Only the upcoming track is worth holding; drop anything the queue moved past.
				for (const prepared of this.ready.values()) prepared.revoke();
				this.ready.clear();
				const url = URL.createObjectURL(blob);
				this.ready.set(song.id, { url, revoke: () => URL.revokeObjectURL(url) });
			})
			.catch(() => {
				// Streaming at track change remains the fallback.
			})
			.finally(() => this.pending.delete(song.id));
	}

	/** Revoke everything, including the playing URL. */
	clear() {
		this.releasePlaying();
		for (const prepared of this.ready.values()) prepared.revoke();
		this.ready.clear();
		this.pending.clear();
		this.prefetchedFor = null;
	}
}
