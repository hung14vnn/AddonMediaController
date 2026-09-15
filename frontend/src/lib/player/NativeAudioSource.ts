import type { PlaybackSource, PlaybackState } from './types';
import { getAudioElement, resumeAudioEngine, suspendAudioEngine } from './audioElement';

const LOAD_TIMEOUT_MS = 15_000;
const STALL_TIMEOUT_MS = 15_000;

type NativeSourceType = 'jellyfin' | 'local' | 'navidrome' | 'plex';

/**
 * `getAudioElement()` hands out one process-wide element, so only the most
 * recently loaded source may drive it. Tracking the owner lets a stale instance
 * skip the teardown steps that would otherwise stop the track that replaced it.
 */
let activeSource: NativeAudioSource | null = null;

export class NativeAudioSource implements PlaybackSource {
	readonly type: NativeSourceType;

	private readonly audio: HTMLAudioElement;
	private readonly url: string;
	private readonly seekable: boolean;

	private stateCallbacks: ((state: PlaybackState) => void)[] = [];
	private readyCallbacks: (() => void)[] = [];
	private errorCallbacks: ((error: { code: string; message: string }) => void)[] = [];
	private progressCallbacks: ((currentTime: number, duration: number) => void)[] = [];

	/** Aborting detaches every listener this instance registered, in one call. */
	private listenerAbort: AbortController | null = null;
	private stallTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
	private loadTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
	private pendingVolume = 75;
	private destroyed = false;
	private currentState: PlaybackState = 'idle';
	private cleanupUrl: (() => void) | null;

	constructor(
		type: NativeSourceType,
		opts: { url: string; seekable: boolean; cleanup?: () => void }
	) {
		this.type = type;
		this.url = opts.url;
		this.seekable = opts.seekable;
		this.audio = getAudioElement();
		this.cleanupUrl = opts.cleanup ?? null;
	}

	async load(info?: { autoplay?: boolean }): Promise<void> {
		this.takeElementOwnership();
		this.destroyed = false;
		this.detachListeners();
		this.clearStallTimeout();
		this.clearLoadTimeout();
		this.emitStateChange('loading');

		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const abort = new AbortController();
			this.listenerAbort = abort;
			const { signal } = abort;
			const on = (event: string, handler: EventListener): void => {
				this.audio.addEventListener(event, handler, { signal });
			};

			const finalize = (action: () => void): void => {
				if (settled || this.destroyed) return;
				settled = true;
				this.clearLoadTimeout();
				action();
			};

			// Whichever ready event fires first wins; `settled` stops the other two
			// from re-entering, so no cross-removal bookkeeping is needed.
			const onReady = (): void => {
				finalize(() => {
					this.emitProgress();
					this.readyCallbacks.forEach((cb) => cb());
					resolve();
				});
			};
			on('canplay', onReady);
			on('loadedmetadata', onReady);
			on('loadeddata', onReady);

			on('play', () => {
				this.clearStallTimeout();
				this.emitStateChange('playing');
			});

			on('playing', () => {
				this.clearStallTimeout();
				this.emitStateChange('playing');
			});

			on('pause', () => {
				if (this.audio.ended) return;
				this.emitStateChange('paused');
			});

			on('ended', () => {
				this.clearStallTimeout();
				this.emitStateChange('ended');
			});

			on('waiting', () => {
				this.emitStateChange('buffering');
				this.startStallTimeout();
			});

			on('stalled', () => this.startStallTimeout());

			on('timeupdate', () => {
				this.clearStallTimeout();
				if (this.currentState === 'buffering') this.emitStateChange('playing');
				this.emitProgress();
			});

			on('durationchange', () => this.emitProgress());
			on('seeked', () => this.emitProgress());

			on('error', () => {
				const code = this.audio.error?.code ?? 0;
				const message = this.getMediaErrorMessage(code);
				this.emitStateChange('error');
				this.emitError('LOAD_ERROR', message);
				finalize(() => reject(new Error(message)));
			});

			this.loadTimeoutHandle = setTimeout(() => {
				this.loadTimeoutHandle = null;
				if (settled || this.destroyed) return;
				settled = true;
				const message = `Native audio source load timed out after ${LOAD_TIMEOUT_MS}ms`;
				// Stop the element before reporting: one still trying to load keeps
				// the request alive and goes on retrying in the background.
				this.audio.pause();
				this.audio.src = '';
				this.detachListeners();
				this.clearStallTimeout();
				this.emitError('LOAD_TIMEOUT', message);
				reject(new Error(message));
			}, LOAD_TIMEOUT_MS);

			// The Vite dev server (:5173) and API (:8688) are different origins.
			// Set this before ``src`` so Web Audio may consume the stream rather
			// than producing a silent, CORS-tainted MediaElementAudioSource. The
			// authenticated stream needs the httpOnly session cookie as well.
			this.audio.crossOrigin = 'use-credentials';
			// Media Session actions can arrive while the document is backgrounded,
			// where a later script-driven play() may be rejected. Let the native
			// element retain the autoplay intent across the source change instead.
			this.audio.autoplay = info?.autoplay === true;
			this.audio.preload = 'auto';
			this.audio.src = this.url;
			this.audio.volume = this.pendingVolume / 100;
			this.audio.load();
		});
	}

	play(): void {
		void this.playWithEngineResume();
	}

	pause(): void {
		this.audio.pause();
		// A running AudioContext keeps a real-time render thread alive even with
		// nothing audible flowing through it, so leaving it running across a long
		// pause is a steady battery and thermal cost. `play()` resumes it again.
		void suspendAudioEngine();
	}

	seekTo(seconds: number): void {
		if (!this.seekable || this.destroyed) {
			return;
		}
		const clamped = Math.max(0, seconds);
		const dur = this.getDuration();
		this.audio.currentTime = dur > 0 ? Math.min(clamped, dur) : clamped;
	}

	setVolume(level: number): void {
		const clamped = Math.max(0, Math.min(100, level));
		this.pendingVolume = clamped;
		if (this.audio.src) {
			this.audio.volume = clamped / 100;
		}
	}

	getCurrentTime(): number {
		const current = this.audio.currentTime;
		return Number.isFinite(current) ? current : 0;
	}

	getDuration(): number {
		const total = this.audio.duration;
		return Number.isFinite(total) ? total : 0;
	}

	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.clearStallTimeout();
		this.clearLoadTimeout();
		this.detachListeners();

		// Only reset the shared element while this instance still owns it. A newer
		// source may already have loaded into it, and clearing `src` then would
		// stop the track that replaced this one.
		if (this.ownsElement()) {
			this.audio.pause();
			this.audio.autoplay = false;
			this.audio.src = '';
			this.audio.load();
			void suspendAudioEngine();
			activeSource = null;
		}

		this.cleanupUrl?.();
		this.cleanupUrl = null;
		this.stateCallbacks = [];
		this.readyCallbacks = [];
		this.errorCallbacks = [];
		this.progressCallbacks = [];
	}

	onStateChange(callback: (state: PlaybackState) => void): void {
		this.stateCallbacks.push(callback);
	}

	onReady(callback: () => void): void {
		this.readyCallbacks.push(callback);
	}

	onError(callback: (error: { code: string; message: string }) => void): void {
		this.errorCallbacks.push(callback);
	}

	onProgress(callback: (currentTime: number, duration: number) => void): void {
		this.progressCallbacks.push(callback);
	}

	isSeekable(): boolean {
		return this.seekable;
	}

	/** Claim the shared element; see `activeSource`. */
	private takeElementOwnership(): void {
		// A module-level ownership handle, not an alias used to reach `this`.
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		activeSource = this;
	}

	private ownsElement(): boolean {
		return activeSource === this;
	}

	private detachListeners(): void {
		this.listenerAbort?.abort();
		this.listenerAbort = null;
	}

	private startStallTimeout(): void {
		this.clearStallTimeout();
		this.stallTimeoutHandle = setTimeout(() => {
			this.stallTimeoutHandle = null;
			if (this.destroyed) return;
			// Park the element rather than leaving it retrying a dead stream;
			// whether to retry is the caller's decision.
			this.audio.pause();
			this.emitError('NETWORK_STALL', `Playback stalled for ${STALL_TIMEOUT_MS}ms`);
			this.emitStateChange('error');
		}, STALL_TIMEOUT_MS);
	}

	private clearStallTimeout(): void {
		if (!this.stallTimeoutHandle) return;
		clearTimeout(this.stallTimeoutHandle);
		this.stallTimeoutHandle = null;
	}

	private clearLoadTimeout(): void {
		if (!this.loadTimeoutHandle) return;
		clearTimeout(this.loadTimeoutHandle);
		this.loadTimeoutHandle = null;
	}

	private async playWithEngineResume(): Promise<void> {
		// Start the native element first. Resuming an optional Web Audio graph can
		// be delayed or rejected while a PWA is backgrounded, but must not delay the
		// media-session transition to the next track.
		let playPromise: Promise<void>;
		try {
			playPromise = this.audio.play();
		} catch {
			this.emitError('AUTOPLAY_BLOCKED', 'Playback failed. Browser may be blocking autoplay.');
			this.emitStateChange('error');
			return;
		}
		void resumeAudioEngine();
		try {
			await playPromise;
		} catch (err: unknown) {
			if (this.destroyed) return;
			const name = err instanceof DOMException || err instanceof Error ? err.name : '';
			if (name === 'NotAllowedError') {
				this.emitError('AUTOPLAY_BLOCKED', 'Playback failed. Browser may be blocking autoplay.');
			} else {
				this.emitError(
					'PLAY_FAILED',
					'Playback failed (' + (name || 'unknown error') + '). The server may not have responded.'
				);
			}
			this.emitStateChange('error');
		}
	}

	private emitProgress(): void {
		if (this.destroyed) return;
		const currentTime = this.getCurrentTime();
		const duration = this.getDuration();
		this.progressCallbacks.forEach((cb) => cb(currentTime, duration));
	}

	private emitStateChange(state: PlaybackState): void {
		if (state === this.currentState) return;
		this.currentState = state;
		this.stateCallbacks.forEach((cb) => cb(state));
	}

	private emitError(code: string, message: string): void {
		this.errorCallbacks.forEach((cb) => cb({ code, message }));
	}

	private getMediaErrorMessage(code: number): string {
		switch (code) {
			case 1:
				return 'MEDIA_ERR_ABORTED: Playback was aborted';
			case 2:
				return 'MEDIA_ERR_NETWORK: A network error occurred';
			case 3:
				return 'MEDIA_ERR_DECODE: Decoding failed due to corruption or unsupported features';
			case 4:
				return 'MEDIA_ERR_SRC_NOT_SUPPORTED: Audio source is not supported';
			default:
				return 'Unknown media error';
		}
	}
}
