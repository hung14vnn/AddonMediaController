import type { NowPlaying } from './types';

type MediaSessionTrack = Pick<
	NowPlaying,
	'trackName' | 'artistName' | 'albumName' | 'coverUrl' | 'coverRemoteUrl'
>;

type MediaSessionAction = 'nexttrack' | 'previoustrack';

export function setMediaSessionActionHandler(
	action: MediaSessionAction,
	handler: (() => void) | null
): void {
	if (typeof navigator === 'undefined' || !navigator.mediaSession) return;

	try {
		navigator.mediaSession.setActionHandler(action, handler);
	} catch {
		// Some browsers expose Media Session without every optional action.
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

/**
 * Supplies the operating system's media controls with the active track details.
 * Without this, Chromium falls back to the document title (for example,
 * "Listening Room · Addonify").
 */
export function updateMediaSessionMetadata(track: MediaSessionTrack | null): void {
	if (typeof navigator === 'undefined' || !navigator.mediaSession) return;

	if (!track) {
		navigator.mediaSession.metadata = null;
		return;
	}

	try {
		navigator.mediaSession.metadata = new MediaMetadata({
			title: track.trackName ?? track.albumName,
			artist: track.artistName,
			album: track.albumName,
			artwork: artworkFor(track)
		});
	} catch {
		// Media Session support varies by browser; playback must remain unaffected.
	}
}
