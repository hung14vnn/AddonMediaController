import { isIOS, isStandalone } from './platform';

/** How long an automatic play() may hang before we assume the browser blocked it. */
const AUTOPLAY_STALL_MS = 10_000;

/**
 * play() for starts the user didn't tap (track changes, repeat, after a call). A
 * backgrounded iOS PWA may reject it or leave it hanging; that is remembered and
 * retried as soon as the page is visible again.
 */
export class Autoplay {
	private blocked = false;

	constructor(
		private audio: HTMLAudioElement,
		/** play() was refused for the current source. */
		private onRefused: () => void
	) {
		document.addEventListener('visibilitychange', this.onVisibilityChange);
	}

	start() {
		const a = this.audio;
		const src = a.src;
		const stall = setTimeout(() => {
			if (a.paused && a.src === src && (document.hidden || (isIOS && isStandalone()))) {
				this.blocked = true;
			}
		}, AUTOPLAY_STALL_MS);
		a.play()
			.then(() => clearTimeout(stall))
			.catch((e: unknown) => {
				clearTimeout(stall);
				// A newer src replaced this one; its own play() owns the state now.
				if (a.src !== src) return;
				this.onRefused();
				if (document.hidden && e instanceof DOMException && e.name === 'NotAllowedError') {
					this.blocked = true;
				}
			});
	}

	/** Playback started, or the user paused: nothing left to retry. */
	cancel() {
		this.blocked = false;
	}

	dispose() {
		document.removeEventListener('visibilitychange', this.onVisibilityChange);
	}

	private readonly onVisibilityChange = () => {
		if (document.visibilityState !== 'visible' || !this.blocked) return;
		this.blocked = false;
		this.start();
	};
}
