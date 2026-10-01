import { beforeEach, describe, expect, it } from 'vitest';
import type { Song } from '../types';
import { clearSnapshot, readSnapshot, writeSnapshot } from './snapshot';

const song = (id: string) => ({ id, title: id }) as Song;

describe('queue snapshot', () => {
	beforeEach(() => localStorage.clear());

	it('round-trips', () => {
		const snapshot = {
			queue: [song('a'), song('b')],
			index: 1,
			time: 42,
			shuffle: true,
			repeat: 'all' as const,
			unshuffled: [song('b'), song('a')]
		};
		writeSnapshot(snapshot);
		expect(readSnapshot()).toEqual(snapshot);
	});

	it('fills defaults and clamps the index to the queue', () => {
		localStorage.setItem('music.queue', JSON.stringify({ queue: [song('a')], index: 5 }));
		expect(readSnapshot()).toEqual({
			queue: [song('a')],
			index: 0,
			time: 0,
			shuffle: false,
			repeat: 'off',
			unshuffled: null
		});
	});

	it('returns null when missing or corrupt, and clears', () => {
		expect(readSnapshot()).toBeNull();
		localStorage.setItem('music.queue', '{nope');
		expect(readSnapshot()).toBeNull();
		writeSnapshot({ queue: [], index: -1, time: 0, shuffle: false, repeat: 'off', unshuffled: null });
		clearSnapshot();
		expect(readSnapshot()).toBeNull();
	});
});
