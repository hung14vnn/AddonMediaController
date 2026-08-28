import { describe, expect, it } from 'vitest';

import { activeLyricWordIndex, normalizeWordTimedLyrics, parseWordTimedLyricLine } from './lyrics';

describe('word-timed lyrics', () => {
	it('parses enhanced lyric timestamps and removes the markers', () => {
		expect(parseWordTimedLyricLine("<00:14.01>I'm <00:14.23>so <00:14.72>glad")).toEqual([
			{ text: "I'm", start_seconds: 14.01 },
			{ text: 'so', start_seconds: 14.23 },
			{ text: 'glad', start_seconds: 14.72 }
		]);
	});

	it('returns the word active at the current playback position', () => {
		const words = parseWordTimedLyricLine('<00:01.00>one <00:02.50>two <00:04>three');

		expect(activeLyricWordIndex(words, 0)).toBe(-1);
		expect(activeLyricWordIndex(words, 3)).toBe(1);
		expect(activeLyricWordIndex(words, 5)).toBe(2);
	});

	it('promotes inline timestamps to synchronized lines when providers omit line timing', () => {
		expect(
			normalizeWordTimedLyrics('<00:01.00>one <00:02.00>two\n<00:03.00>three', [], false)
		).toEqual({
			is_synced: true,
			lines: [
				{ text: '<00:01.00>one <00:02.00>two', start_seconds: 1 },
				{ text: '<00:03.00>three', start_seconds: 3 }
			]
		});
	});

	it('leaves ordinary line lyrics unchanged', () => {
		const lines = [{ text: 'Plain lyrics', start_seconds: null }];
		expect(normalizeWordTimedLyrics('Plain lyrics', lines, false)).toEqual({
			is_synced: false,
			lines
		});
	});
});
