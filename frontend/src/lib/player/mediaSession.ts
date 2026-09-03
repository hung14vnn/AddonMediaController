import type { NowPlaying } from './types';

type MediaSessionTrack = Pick<
	NowPlaying,
	| 'trackName'
	| 'artistName'
	| 'albumName'
	| 'coverUrl'
	| 'coverRemoteUrl'
	| 'discNumber'
	| 'trackNumber'
>;

type PlayerMediaSessionAction =
	| 'play'
	| 'pause'
	| 'seekbackward'
	| 'seekforward'
	| 'seekto'
	| 'nexttrack'
	| 'previoustrack';

export function setMediaSessionActionHandler(
	action: PlayerMediaSessionAction,
	handler: ((details: MediaSessionActionDetails) => void) | null
): void {
	if (typeof navigator === 'undefined' || !navigator.mediaSession) return;

	try {
		navigator.mediaSession.setActionHandler(action, handler);
	} catch {
		// Some browsers expose Media Session without every optional action.
	}
}

/** Keep the OS-level media notification in sync with the app player. */
export function updateMediaSessionPlaybackState(state: 'none' | 'paused' | 'playing'): void {
	if (typeof navigator === 'undefined' || !navigator.mediaSession) return;

	try {
		navigator.mediaSession.playbackState = state;
	} catch {
		// Playback state is optional on older Media Session implementations.
	}
}

/** Supply progress to lock-screen controls without affecting unsupported browsers. */
export function updateMediaSessionPosition(position: number, duration: number): void {
	if (
		typeof navigator === 'undefined' ||
		!navigator.mediaSession ||
		typeof navigator.mediaSession.setPositionState !== 'function' ||
		!Number.isFinite(position) ||
		!Number.isFinite(duration) ||
		duration <= 0
	) {
		return;
	}

	try {
		navigator.mediaSession.setPositionState({
			duration,
			playbackRate: 1,
			position: Math.max(0, Math.min(position, duration))
		});
	} catch {
		// Some browsers expose the method but reject particular stream durations.
	}
}

function artworkFor(track: MediaSessionTrack): MediaImage[] | undefined {
	const coverUrl = track.coverUrl ?? track.coverRemoteUrl;
	if (!coverUrl) return undefined;

	try {
		return [{ src: new URL(coverUrl, window.location.origin).href }];
	} catch {
		return undefined;
	}
}

function mediaSessionTitle(track: MediaSessionTrack): string {
	const title = track.trackName?.trim() || track.albumName;
	const disc = Number(track.discNumber ?? 0);
	const position = Number(track.trackNumber ?? 0);
	if (disc <= 0 || position <= 0) return title;

	const prefix = `${String(disc).padStart(2, '0')}${String(position).padStart(2, '0')}`;
	if (!title.startsWith(prefix)) return title;
	const remainder = title.slice(prefix.length);
	return /^\s/.test(remainder) && remainder.trim() ? remainder.trim() : title;
}

/**
 * Supplies the operating system's media controls with the active track details.
 * Without this, Chromium falls back to the document title (for example,
 * "Listening Room · hify").
 */
export function updateMediaSessionMetadata(track: MediaSessionTrack | null): void {
	if (typeof navigator === 'undefined' || !navigator.mediaSession) return;

	if (!track) {
		navigator.mediaSession.metadata = null;
		return;
	}

	try {
		navigator.mediaSession.metadata = new MediaMetadata({
			title: mediaSessionTitle(track),
			artist: track.artistName,
			album: track.albumName,
			artwork: artworkFor(track)
		});
	} catch {
		// Media Session support varies by browser; playback must remain unaffected.
	}
}
