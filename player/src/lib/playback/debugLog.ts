const LOG_KEY = 'music.playbackLog';
const ENABLED_KEY = 'music.playbackLogEnabled';
/** Enough for several track changes; older entries drop off. */
const MAX_ENTRIES = 400;

export function isPlaybackLogEnabled(): boolean {
	try {
		return localStorage.getItem(ENABLED_KEY) !== 'false';
	} catch {
		return true;
	}
}

export function setPlaybackLogEnabled(enabled: boolean) {
	try {
		localStorage.setItem(ENABLED_KEY, enabled ? 'true' : 'false');
	} catch {}
}

/**
 * Playback event log kept in localStorage, so what happened with the screen off can be
 * read (and copied from the Account page) after the fact. Written on every entry: the
 * page may be killed at any moment in the background.
 */
export function logPlayback(event: string, detail = '') {
	if (!isPlaybackLogEnabled()) return;
	try {
		const entries = readPlaybackLog();
		const time = new Date().toISOString().slice(11, 23);
		const hidden = typeof document !== 'undefined' && document.hidden ? ' [hidden]' : '';
		entries.push(`${time} ${event}${hidden}${detail ? ' ' + detail : ''}`);
		localStorage.setItem(LOG_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
	} catch {
		/* storage full or unavailable */
	}
}

export function readPlaybackLog(): string[] {
	try {
		const raw = localStorage.getItem(LOG_KEY);
		return raw ? (JSON.parse(raw) as string[]) : [];
	} catch {
		return [];
	}
}

export function clearPlaybackLog() {
	try {
		localStorage.removeItem(LOG_KEY);
	} catch {
		/* ignore */
	}
}
