import type { LyricLine } from '$lib/types';

export type LyricWord = {
	text: string;
	start_seconds: number;
};

/** Enhanced lyrics use <MM:SS.xx> markers before each word. */
const WORD_TIMESTAMP = /<(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?>/g;

function timestampToSeconds(minutes: string, seconds: string, fraction = ''): number {
	return Number(minutes) * 60 + Number(seconds) + (fraction ? Number(`0.${fraction}`) : 0);
}

export function parseWordTimedLyricLine(text: string): LyricWord[] {
	const matches = [...text.matchAll(WORD_TIMESTAMP)];
	if (matches.length === 0) return [];

	return matches
		.map((match, index) => {
			const start = (match.index ?? 0) + match[0].length;
			const end = matches[index + 1]?.index ?? text.length;
			return {
				text: text.slice(start, end).trim(),
				start_seconds: timestampToSeconds(match[1], match[2], match[3])
			};
		})
		.filter((word) => word.text.length > 0);
}

export function activeLyricWordIndex(words: LyricWord[], currentTime: number): number {
	let active = -1;
	for (let index = 0; index < words.length; index += 1) {
		if (words[index].start_seconds <= currentTime) active = index;
		else break;
	}
	return active;
}

/** Promote inline timestamps to synchronized lines when a provider omits line timing. */
export function normalizeWordTimedLyrics(
	text: string,
	lines: LyricLine[],
	isSynced: boolean
): { lines: LyricLine[]; is_synced: boolean } {
	const sourceLines =
		lines.length > 0
			? lines
			: text.split(/\r?\n/).map((value) => ({ text: value, start_seconds: null }));
	const normalizedLines = sourceLines.map((line) => {
		const words = parseWordTimedLyricLine(line.text);
		if (words.length === 0) return line;
		return {
			...line,
			start_seconds: line.start_seconds ?? words[0].start_seconds
		};
	});
	const hasWordTiming = normalizedLines.some(
		(line) => parseWordTimedLyricLine(line.text).length > 0
	);

	return {
		lines: hasWordTiming ? normalizedLines : lines,
		is_synced: isSynced || hasWordTiming
	};
}
