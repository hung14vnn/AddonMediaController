/** Playing with no clock movement for this long means the stream died. */
export const STALL_MS = 8_000;
const CHECK_MS = 2_000;
/** Reloads per track before giving up, so a dead server isn't hammered. */
export const MAX_RECOVERIES = 3;
/** HTMLMediaElement.HAVE_FUTURE_DATA: enough buffered to keep playing. */
const HAVE_FUTURE_DATA = 3;

/**
 * Detects a stream that stopped delivering data mid-track (network drop, Wi-Fi/4G
 * switch, a request the server stopped answering). The element then sits "playing"
 * with a frozen clock and no sound, and pause/play on the same element does not
 * recover; only a fresh request at the current position does.
 */
export class StallWatchdog {
	private timer: ReturnType<typeof setInterval> | undefined;
	private lastTime = -1;
	private lastMoveAt = 0;
	private recoveries = 0;
	private trackId: string | null = null;

	constructor(
		private audio: HTMLAudioElement,
		/** Reload the current track at its current position. */
		private recover: () => void
	) {
		audio.addEventListener('play', this.arm);
		audio.addEventListener('pause', this.disarm);
		audio.addEventListener('ended', this.disarm);
		audio.addEventListener('timeupdate', this.onProgress);
	}

	/** A track is loading; a different one gets a fresh recovery budget. */
	track(id: string) {
		if (id !== this.trackId) {
			this.trackId = id;
			this.recoveries = 0;
		}
		this.lastTime = -1;
		this.lastMoveAt = performance.now();
	}

	/**
	 * The element can't play from what it has and hasn't moved in a while: play()
	 * on it would just sit there, so the caller should reload instead.
	 */
	needsReload() {
		return this.audio.readyState < HAVE_FUTURE_DATA && performance.now() - this.lastMoveAt > STALL_MS;
	}

	dispose() {
		this.disarm();
		this.audio.removeEventListener('play', this.arm);
		this.audio.removeEventListener('pause', this.disarm);
		this.audio.removeEventListener('ended', this.disarm);
		this.audio.removeEventListener('timeupdate', this.onProgress);
	}

	private readonly onProgress = () => {
		if (this.audio.currentTime === this.lastTime) return;
		this.lastTime = this.audio.currentTime;
		this.lastMoveAt = performance.now();
	};

	private readonly arm = () => {
		this.lastMoveAt = performance.now();
		if (this.timer === undefined) this.timer = setInterval(this.check, CHECK_MS);
	};

	private readonly disarm = () => {
		clearInterval(this.timer);
		this.timer = undefined;
	};

	private readonly check = () => {
		if (this.audio.paused) return this.disarm();
		if (performance.now() - this.lastMoveAt < STALL_MS) return;
		if (this.recoveries >= MAX_RECOVERIES) return this.disarm();
		this.recoveries++;
		this.lastMoveAt = performance.now();
		this.recover();
	};
}
