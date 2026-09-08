import { playerStore } from './player.svelte';
import { playbackToast } from './playbackToast.svelte';

const SLEEP_TIMER_STORAGE_KEY = 'droppedneedle.sleepTimer';

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

function createSleepTimerStore() {
	let mode = $state<SleepTimerMode | null>(null);
	let endAt = $state<number | null>(null);
	let remainingSeconds = $state(0);
	let intervalId: ReturnType<typeof setInterval> | null = null;
	let fired = $state(false);

	// ── lifecycle ──────────────────────────────────────────────────────────

	function startCountdown(endTimestamp: number): void {
		mode = 'countdown';
		endAt = endTimestamp;
		remainingSeconds = Math.max(0, Math.ceil((endTimestamp - Date.now()) / 1000));
		fired = false;
		savePersisted({ mode, endAt });
		ensureInterval();
	}

	function startEndOfTrack(): void {
		cancelCountdown();
		mode = END_OF_TRACK_MODE;
		endAt = null;
		remainingSeconds = 0;
		fired = false;
		savePersisted({ mode, pending: true });
	}

	function cancelCountdown(): void {
		if (intervalId) {
			clearInterval(intervalId);
			intervalId = null;
		}
		mode = null;
		endAt = null;
		remainingSeconds = 0;
		savePersisted(null);
	}

	function ensureInterval(): void {
		if (intervalId) return;
		intervalId = setInterval(() => {
			if (mode !== 'countdown' || endAt === null) return;
			remainingSeconds = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
			if (remainingSeconds <= 0) fireTimer();
		}, 250);
	}

	function fireTimer(): void {
		if (fired) return;
		fired = true;
		cancelCountdown();
		playerStore.pause();
		playbackToast.show('Sleep timer ended', 'info');
	}

	// Restore any persisted timer on module load.
	const persisted = loadPersisted();
	if (persisted) {
		if (persisted.mode === 'countdown' && persisted.endAt) {
			// If the timer already passed while the page was closed, don't re-fire.
			if (persisted.endAt > Date.now()) {
				startCountdown(persisted.endAt);
			} else {
				savePersisted(null);
			}
		} else if (persisted.mode === END_OF_TRACK_MODE) {
			startEndOfTrack();
		}
	}

	return {
		get isActive() {
			return mode !== null;
		},
		get isCountdown() {
			return mode === 'countdown';
		},
		get isEndOfTrack() {
			return mode === END_OF_TRACK_MODE;
		},
		get remainingLabel() {
			if (mode === 'countdown') return formatDuration(remainingSeconds);
			if (mode === END_OF_TRACK_MODE) return 'End of track';
			return '';
		},

		setMinutes(minutes: number): void {
			if (minutes <= 0) {
				cancelCountdown();
				return;
			}
			startCountdown(Date.now() + minutes * 60_000);
		},

		setEndOfTrack(): void {
			startEndOfTrack();
		},

		cancel(): void {
			cancelCountdown();
		},

		/** Called by the player loop when a track naturally finishes playing. */
		onTrackEnded(): boolean {
			if (mode !== END_OF_TRACK_MODE) return false;
			fired = true;
			cancelCountdown();
			playerStore.pause();
			playbackToast.show('Sleep timer ended', 'info');
			return true;
		}
	};
}

export const sleepTimerStore = createSleepTimerStore();
