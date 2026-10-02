/** Safari's Audio Session API (iOS 17+); not in TypeScript's DOM lib yet. */
type AudioSessionLike = EventTarget & {
	type: string;
	readonly state: 'inactive' | 'active' | 'interrupted';
};

/** A system pause this close before an interruption is treated as part of it. */
const SYSTEM_PAUSE_WINDOW_MS = 2000;

/**
 * Phone calls, Siri and alarms take the iOS audio session. WebKit can leave the
 * element "playing" through a call (the clock runs on with no output) and nothing
 * resumes it afterwards, so pause for real and resume once the interruption ends.
 * Does nothing where `navigator.audioSession` is missing (non-Safari, iOS < 17).
 */
export class InterruptionGuard {
	private session: AudioSessionLike | null;
	private resumeAfter = false;
	private userPausing = false;
	private systemPausedAt = -Infinity;

	constructor(
		private audio: HTMLAudioElement,
		private resume: () => void
	) {
		this.session = (navigator as Navigator & { audioSession?: AudioSessionLike }).audioSession ?? null;
		if (!this.session) return;
		try {
			// Media playback, like a music app: proper interruption handling, ignores the mute switch.
			this.session.type = 'playback';
		} catch {
			/* read-only on some versions */
		}
		this.session.addEventListener('statechange', this.onStateChange);
		audio.addEventListener('pause', this.onPause);
	}

	/** Call just before a user-initiated pause so it isn't mistaken for the system's. */
	userPause() {
		this.resumeAfter = false;
		this.userPausing = true;
	}

	dispose() {
		this.session?.removeEventListener('statechange', this.onStateChange);
		this.audio.removeEventListener('pause', this.onPause);
	}

	private readonly onPause = () => {
		this.systemPausedAt = this.userPausing ? -Infinity : performance.now();
		this.userPausing = false;
	};

	private readonly onStateChange = () => {
		if (this.session?.state === 'interrupted') {
			// Some versions fire 'pause' themselves just before reporting the interruption.
			if (!this.audio.paused || performance.now() - this.systemPausedAt < SYSTEM_PAUSE_WINDOW_MS) {
				this.resumeAfter = true;
				this.audio.pause();
			}
		} else if (this.resumeAfter) {
			this.resumeAfter = false;
			this.resume();
		}
	};
}
