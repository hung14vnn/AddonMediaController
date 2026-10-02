import { coverUrl } from '../api';
import type { Song } from '../types';

export interface MediaSessionControls {
	play(): void;
	pause(): void;
	previous(): void;
	next(): void;
	seek(seconds: number): void;
	currentTime(): number;
}

const supported = () => typeof navigator !== 'undefined' && 'mediaSession' in navigator;

/** iPadOS reports a Mac user agent; touch support tells them apart. */
const isIOS =
	typeof navigator !== 'undefined' &&
	(/iphone|ipad|ipod/i.test(navigator.userAgent) ||
		(/mac/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1));

/** Lock-screen / Control Centre / notification controls. */
export function setupMediaSession(audio: HTMLAudioElement, controls: MediaSessionControls) {
	if (!supported()) return;
	const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
		['play', () => controls.play()],
		['pause', () => controls.pause()],
		['previoustrack', () => controls.previous()],
		['nexttrack', () => controls.next()],
		['seekto', (d) => d.seekTime !== undefined && controls.seek(d.seekTime)]
	];
	// iOS shows ±10s buttons instead of previous/next track whenever seek
	// handlers exist, so they are only registered on other platforms.
	if (!isIOS) {
		handlers.push(
			['seekbackward', (d) => controls.seek(Math.max(0, controls.currentTime() - (d.seekOffset ?? 10)))],
			['seekforward', (d) => controls.seek(controls.currentTime() + (d.seekOffset ?? 10))]
		);
	}
	const register = () => {
		for (const [action, handler] of handlers) {
			try {
				navigator.mediaSession.setActionHandler(action, handler);
			} catch {
				/* action unsupported */
			}
		}
	};
	register();
	// Handlers set before playback starts can still leave iOS on the ±10s layout;
	// registering again on the first 'playing' gives previous/next track.
	if (isIOS) audio.addEventListener('playing', register, { once: true });
}

export function setMediaMetadata(song: Song | null) {
	if (!song || !supported()) return;
	const artwork = [300, 600].map((size) => ({
		src: coverUrl(song.coverArt, size) ?? '',
		sizes: `${size}x${size}`,
		type: 'image/jpeg'
	}));
	navigator.mediaSession.metadata = new MediaMetadata({
		title: song.title,
		artist: song.displayArtist ?? song.artist ?? '',
		album: song.album ?? '',
		artwork: song.coverArt ? artwork : []
	});
}

export function setMediaPosition(duration: number, position: number, playbackRate: number) {
	if (!supported() || !duration) return;
	try {
		navigator.mediaSession.setPositionState({
			duration,
			position: Math.min(position, duration),
			playbackRate
		});
	} catch {
		/* invalid state mid-load */
	}
}

/** Drop the lock-screen controls (the page is going away). */
export function clearMediaSession() {
	if (supported()) navigator.mediaSession.playbackState = 'none';
}
