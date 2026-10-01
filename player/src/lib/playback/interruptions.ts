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
	private lastSystemPauseAt = 0;

	constructor(
		private audio: HTMLAudioElement,
		/** Start playback again once the interruption is over. */
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
	}

	/** Call just before a user-initiated pause so it isn't mistaken for the system's. */
	userPause() {
		this.resumeAfter = false;
		this.userPausing = true;
	}

	/** Call from the element's 'pause' event. */
	notePause() {
		this.lastSystemPauseAt = this.userPausing ? 0 : performance.now();
		this.userPausing = false;
	}

	dispose() {
		this.session?.removeEventListener('statechange', this.onStateChange);
	}

	private readonly onStateChange = () => {
		const session = this.session;
		if (!session) return;
		if (session.state === 'interrupted') {
			// Some versions fire 'pause' themselves just before reporting the interruption.
			const justPausedBySystem = performance.now() - this.lastSystemPauseAt < SYSTEM_PAUSE_WINDOW_MS;
			if (!this.audio.paused || justPausedBySystem) {
				this.resumeAfter = true;
				this.audio.pause();
			}
			return;
		}
		if (this.resumeAfter) {
			this.resumeAfter = false;
			this.resume();
		}
	};
}
