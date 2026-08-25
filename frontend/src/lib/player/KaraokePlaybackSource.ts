import type { PlaybackSource, PlaybackState } from './types';
import { getAudioElement, resumeAudioEngine, tryGetAudioEngine } from './audioElement';
import type { AuxiliaryAudioConnection } from './audioEngine';

const LOAD_TIMEOUT_MS = 20_000;
const DRIFT_CORRECTION_SECONDS = 0.12;

export class KaraokePlaybackSource implements PlaybackSource {
	readonly type = 'local' as const;

	private readonly instrumental = getAudioElement();
	private readonly vocals = new Audio();
	private auxiliary: AuxiliaryAudioConnection | null = null;
	private listeners: Array<{ element: HTMLAudioElement; event: string; handler: EventListener }> =
		[];
	private stateCallbacks: ((state: PlaybackState) => void)[] = [];
	private readyCallbacks: (() => void)[] = [];
	private errorCallbacks: ((error: { code: string; message: string }) => void)[] = [];
	private progressCallbacks: ((currentTime: number, duration: number) => void)[] = [];
	private masterVolume = 75;
	private vocalLevel = 100;
	private destroyed = false;

	constructor(
		private readonly instrumentalUrl: string,
		private readonly vocalsUrl: string
	) {}

	async load(): Promise<void> {
		this.destroyed = false;
		this.emitState('loading');
		this.instrumental.crossOrigin = 'use-credentials';
		this.vocals.crossOrigin = 'use-credentials';
		this.vocals.preload = 'auto';
		this.auxiliary = tryGetAudioEngine()?.connectAuxiliary(this.vocals) ?? null;
		this.registerPlaybackEvents();
		this.instrumental.src = this.instrumentalUrl;
		this.vocals.src = this.vocalsUrl;
		this.applyVolumes();
		this.instrumental.load();
		this.vocals.load();
		await Promise.all([this.waitUntilReady(this.instrumental), this.waitUntilReady(this.vocals)]);
		if (this.destroyed) throw new Error('Karaoke playback was cancelled');
		this.readyCallbacks.forEach((callback) => callback());
		this.emitProgress();
	}

	play(): void {
		void this.playBoth();
	}

	pause(): void {
		this.instrumental.pause();
		this.vocals.pause();
	}

	seekTo(seconds: number): void {
		const duration = this.getDuration();
		const target = Math.max(0, duration > 0 ? Math.min(seconds, duration) : seconds);
		this.instrumental.currentTime = target;
		this.vocals.currentTime = target;
	}

	setVolume(level: number): void {
		this.masterVolume = Math.max(0, Math.min(100, level));
		this.applyVolumes();
	}

	setVocalLevel(level: number): void {
		this.vocalLevel = Math.max(0, Math.min(100, level));
		this.applyVolumes();
	}

	getCurrentTime(): number {
		return Number.isFinite(this.instrumental.currentTime) ? this.instrumental.currentTime : 0;
	}

	getDuration(): number {
		const values = [this.instrumental.duration, this.vocals.duration].filter(Number.isFinite);
		return values.length ? Math.min(...values) : 0;
	}

	isSeekable(): boolean {
		return true;
	}

	destroy(): void {
		this.destroyed = true;
		this.cleanupListeners();
		this.auxiliary?.destroy();
		this.auxiliary = null;
		for (const element of [this.instrumental, this.vocals]) {
			element.pause();
			element.removeAttribute('src');
			element.load();
		}
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

	private registerPlaybackEvents(): void {
		this.listen(this.instrumental, 'playing', () => this.emitState('playing'));
		this.listen(this.instrumental, 'pause', () => {
			if (!this.instrumental.ended) this.emitState('paused');
		});
		this.listen(this.instrumental, 'waiting', () => this.emitState('buffering'));
		this.listen(this.instrumental, 'ended', () => this.emitState('ended'));
		this.listen(this.instrumental, 'timeupdate', () => {
			this.correctDrift();
			this.emitProgress();
		});
		for (const element of [this.instrumental, this.vocals]) {
			this.listen(element, 'error', () => {
				this.emitState('error');
				this.errorCallbacks.forEach((callback) =>
					callback({ code: 'KARAOKE_LOAD_ERROR', message: 'A karaoke stem could not be played' })
				);
			});
		}
	}

	private async playBoth(): Promise<void> {
		try {
			await resumeAudioEngine();
			this.correctDrift(true);
			await Promise.all([this.vocals.play(), this.instrumental.play()]);
		} catch {
			this.instrumental.pause();
			this.vocals.pause();
			this.emitState('error');
			this.errorCallbacks.forEach((callback) =>
				callback({ code: 'AUTOPLAY_BLOCKED', message: 'Browser blocked karaoke playback' })
			);
		}
	}

	private correctDrift(force = false): void {
		if (this.vocals.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
		const drift = this.vocals.currentTime - this.instrumental.currentTime;
		if (force || Math.abs(drift) > DRIFT_CORRECTION_SECONDS) {
			this.vocals.currentTime = this.instrumental.currentTime;
		}
	}

	private applyVolumes(): void {
		const master = this.masterVolume / 100;
		const vocal = master * (this.vocalLevel / 100);
		this.instrumental.volume = master;
		if (this.auxiliary) {
			this.vocals.volume = 1;
			this.auxiliary.setGain(vocal);
		} else {
			this.vocals.volume = vocal;
		}
	}

	private waitUntilReady(element: HTMLAudioElement): Promise<void> {
		if (element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return Promise.resolve();
		return new Promise((resolve, reject) => {
			let timeout: ReturnType<typeof setTimeout>;
			const ready = () => finish(resolve);
			const error = () => finish(() => reject(new Error('Karaoke stem failed to load')));
			const finish = (action: () => void) => {
				clearTimeout(timeout);
				element.removeEventListener('canplay', ready);
				element.removeEventListener('error', error);
				action();
			};
			timeout = setTimeout(
				() => finish(() => reject(new Error('Karaoke stem load timed out'))),
				LOAD_TIMEOUT_MS
			);
			element.addEventListener('canplay', ready, { once: true });
			element.addEventListener('error', error, { once: true });
		});
	}

	private listen(element: HTMLAudioElement, event: string, callback: () => void): void {
		const handler = callback as EventListener;
		element.addEventListener(event, handler);
		this.listeners.push({ element, event, handler });
	}

	private cleanupListeners(): void {
		for (const { element, event, handler } of this.listeners) {
			element.removeEventListener(event, handler);
		}
		this.listeners = [];
	}

	private emitState(state: PlaybackState): void {
		this.stateCallbacks.forEach((callback) => callback(state));
	}

	private emitProgress(): void {
		const time = this.getCurrentTime();
		const duration = this.getDuration();
		this.progressCallbacks.forEach((callback) => callback(time, duration));
	}
}
