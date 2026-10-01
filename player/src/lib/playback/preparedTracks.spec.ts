import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Song } from '../types';
import { PREFETCH_MAX_DURATION_S, PreparedTracks } from './preparedTracks';

const song = (id: string, duration = 200) => ({ id, title: id, duration }) as Song;
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('PreparedTracks.prefetch', () => {
	let revoked: string[];
	let n: number;

	beforeEach(() => {
		revoked = [];
		n = 0;
		URL.createObjectURL = vi.fn(() => `blob:test/${++n}`);
		URL.revokeObjectURL = vi.fn((url: string) => void revoked.push(url));
	});
	afterEach(() => vi.unstubAllGlobals());

	it('downloads the upcoming track into a blob URL that take() hands over once', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('audio')));
		const prepared = new PreparedTracks();
		prepared.prefetch(song('b'), '/stream?id=b', () => true);
		await flush();
		expect(prepared.take('b')).toBe('blob:test/1');
		expect(prepared.take('b')).toBeNull();
	});

	it('tries only once per track, even after a failure', async () => {
		const fetchMock = vi.fn(async () => new Response('', { status: 500 }));
		vi.stubGlobal('fetch', fetchMock);
		const prepared = new PreparedTracks();
		for (let i = 0; i < 5; i++) prepared.prefetch(song('b'), '/stream?id=b', () => true);
		await flush();
		prepared.prefetch(song('b'), '/stream?id=b', () => true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(prepared.take('b')).toBeNull();

		// A new track resets the attempt.
		prepared.startTrack();
		prepared.prefetch(song('b'), '/stream?id=b', () => true);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('drops the download when the queue moved on meanwhile', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('audio')));
		const prepared = new PreparedTracks();
		prepared.prefetch(song('b'), '/stream?id=b', () => false);
		await flush();
		expect(prepared.take('b')).toBeNull();
		expect(URL.createObjectURL).not.toHaveBeenCalled();
	});

	it('skips long mixes', () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		new PreparedTracks().prefetch(song('mix', PREFETCH_MAX_DURATION_S + 1), '/stream?id=mix', () => true);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('revokes the previous playing URL on take() and everything on clear()', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('audio')));
		const prepared = new PreparedTracks();
		prepared.prefetch(song('b'), '/b', () => true);
		await flush();
		prepared.take('b'); // playing: blob:test/1
		prepared.startTrack();
		prepared.prefetch(song('c'), '/c', () => true);
		await flush();
		prepared.take('c'); // playing: blob:test/2, releases 1
		expect(revoked).toEqual(['blob:test/1']);
		prepared.clear();
		expect(revoked).toEqual(['blob:test/1', 'blob:test/2']);
	});
});
