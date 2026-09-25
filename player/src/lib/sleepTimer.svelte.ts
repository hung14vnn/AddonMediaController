import { getPlayer } from './player.svelte';
import { ui } from './ui.svelte';

const SLEEP_TIMER_STORAGE_KEY = 'hify.sleepTimer';

/** How long (seconds) a timer is kept as "active" after the first wire-up cycle. */
const END_OF_TRACK_MODE = 'eot' as const;

type SleepTimerMode = 'countdown' | typeof END_OF_TRACK_MODE;

interface PersistedSleepTimer {
	mode: SleepTimerMode;
	/** Countdown mode: epoch-ms when the timer should fire. */
	endAt?: number;
	/** End-of-track mode: consumed once when playback naturally ends. */
	pending?: boolean;
}

function formatDuration(totalSeconds: number): string {
	const seconds = Math.max(0, Math.round(totalSeconds));
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const secs = seconds % 60;
	if (hours > 0)
		return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
	return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function loadPersisted(): PersistedSleepTimer | null {
	try {
		const raw = localStorage.getItem(SLEEP_TIMER_STORAGE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as PersistedSleepTimer;
		if (parsed.mode === 'countdown' && typeof parsed.endAt !== 'number') return null;
		if (parsed.mode === END_OF_TRACK_MODE && parsed.pending !== true) return null;
		return parsed;
	} catch {
		try {
			localStorage.removeItem(SLEEP_TIMER_STORAGE_KEY);
		} catch {
			/* empty */
		}
		return null;
	}
}

function savePersisted(state: PersistedSleepTimer | null): void {
	try {
		if (state) localStorage.setItem(SLEEP_TIMER_STORAGE_KEY, JSON.stringify(state));
		else localStorage.removeItem(SLEEP_TIMER_STORAGE_KEY);
	} catch {
		/* empty */
	}
}

class SleepTimer {
	mode = $state<SleepTimerMode | null>(null);
	endAt = $state<number | null>(null);
	remainingSeconds = $state(0);
	intervalId: ReturnType<typeof setInterval> | null = null;
	fired = $state(false);

	constructor() {
		// Restore any persisted timer on module load.
		const persisted = loadPersisted();
		if (persisted) {
			if (persisted.mode === 'countdown' && persisted.endAt) {
				// If the timer already passed while the page was closed, don't re-fire.
				if (persisted.endAt > Date.now()) {
					this.startCountdown(persisted.endAt);
				} else {
					savePersisted(null);
				}
			} else if (persisted.mode === END_OF_TRACK_MODE) {
				this.startEndOfTrack();
			}
		}
	}

	get isActive() {
		return this.mode !== null;
	}

	get isCountdown() {
		return this.mode === 'countdown';
	}

	get isEndOfTrack() {
		return this.mode === END_OF_TRACK_MODE;
	}

	get remainingLabel() {
		if (this.mode === 'countdown') return formatDuration(this.remainingSeconds);
		if (this.mode === END_OF_TRACK_MODE) return 'End of track';
		return '';
	}

	setMinutes(minutes: number): void {
		if (minutes <= 0) {
			this.cancelCountdown();
			return;
		}
		this.startCountdown(Date.now() + minutes * 60_000);
	}

	setEndOfTrack(): void {
		this.startEndOfTrack();
	}

	cancel(): void {
		this.cancelCountdown();
	}

	/** Called by the player loop when a track naturally finishes playing. */
	onTrackEnded(): boolean {
		if (this.mode !== END_OF_TRACK_MODE) return false;
		this.fired = true;
		this.cancelCountdown();
		getPlayer().pause();
		ui.showToast('Sleep timer ended');
		return true;
	}

	private startCountdown(endTimestamp: number): void {
		this.mode = 'countdown';
		this.endAt = endTimestamp;
		this.remainingSeconds = Math.max(0, Math.ceil((endTimestamp - Date.now()) / 1000));
		this.fired = false;
		savePersisted({ mode: this.mode, endAt: this.endAt });
		this.ensureInterval();
	}

	private startEndOfTrack(): void {
		this.cancelCountdown();
		this.mode = END_OF_TRACK_MODE;
		this.endAt = null;
		this.remainingSeconds = 0;
		this.fired = false;
		savePersisted({ mode: this.mode, pending: true });
	}

	private cancelCountdown(): void {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
		this.mode = null;
		this.endAt = null;
		this.remainingSeconds = 0;
		savePersisted(null);
	}

	private ensureInterval(): void {
		if (this.intervalId) return;
		this.intervalId = setInterval(() => {
			if (this.mode !== 'countdown' || this.endAt === null) return;
			this.remainingSeconds = Math.max(0, Math.ceil((this.endAt - Date.now()) / 1000));
			if (this.remainingSeconds <= 0) this.fireTimer();
		}, 250);
	}

	private fireTimer(): void {
		if (this.fired) return;
		this.fired = true;
		this.cancelCountdown();
		getPlayer().pause();
		ui.showToast('Sleep timer ended');
	}
}

export const sleepTimer = new SleepTimer();
