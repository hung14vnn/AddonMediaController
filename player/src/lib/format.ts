import type { Song } from './types';

export function time(seconds: number | undefined) {
	if (!seconds || !Number.isFinite(seconds)) return '0:00';
	const s = Math.floor(seconds);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = String(s % 60).padStart(2, '0');
	return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export function totalDuration(songs: Song[]) {
	const total = songs.reduce((sum, s) => sum + (s.duration ?? 0), 0);
	const h = Math.floor(total / 3600);
	const m = Math.round((total % 3600) / 60);
	if (h) return `${h} hour${h === 1 ? '' : 's'}, ${m} minute${m === 1 ? '' : 's'}`;
	return `${m} minute${m === 1 ? '' : 's'}`;
}

export function plural(n: number, word: string) {
	return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function artistName(item: { displayArtist?: string; artist?: string }) {
	return item.displayArtist || item.artist || 'Unknown Artist';
}

/** Stable pastel-ish hue from a string, for placeholder art and genre tiles. */
export function hue(text: string) {
	let h = 0;
	for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) % 360;
	return h;
}

export function stripHtml(html: string | undefined) {
	if (!html) return '';
	const doc = new DOMParser().parseFromString(html, 'text/html');
	return (doc.body.textContent ?? '').trim();
}
