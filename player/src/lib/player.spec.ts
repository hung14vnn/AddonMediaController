// Track-change paths of the Player, driven through a fake <audio> (jsdom has no media
// playback). The key invariant: a change from `ended` sets the next src synchronously,
// because awaits there can be suspended in a backgrounded PWA.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Song } from './types';

vi.mock('./api', () => ({
	getPlayQueue: vi.fn(async () => null),
	savePlayQueue: vi.fn(),
	scrobble: vi.fn(),
	streamUrl: (id: string) => `https://music.test/rest/stream?id=${id}`,
	coverUrl: () => undefined,
	getSession: () => null
}));

const sleepTimer = { onTrackEnded: vi.fn(() => false) };
vi.mock('./sleepTimer.svelte', () => ({ sleepTimer }));

class FakeAudio extends EventTarget {
	static last: FakeAudio;
	preload = '';
	paused = true;
	currentTime = 0;
	duration = NaN;
	volume = 1;
	muted = false;
	playbackRate = 1;
	src = '';
	load = vi.fn();
	play = vi.fn(() => {
		this.paused = false;
		this.dispatchEvent(new Event('play'));
		return Promise.resolve();
	});
	pause = vi.fn(() => {
		if (this.paused) return;
		this.paused = true;
		this.dispatchEvent(new Event('pause'));
	});
	constructor() {
		super();
		FakeAudio.last = this;
	}
	removeAttribute(name: string) {
		if (name === 'src') this.src = '';
	}
	fire(type: string) {
		this.dispatchEvent(new Event(type));
	}
}

class FakeAudioSession extends EventTarget {
	type = 'auto';
	state: 'inactive' | 'active' | 'interrupted' = 'active';
	set(state: FakeAudioSession['state']) {
		this.state = state;
		this.dispatchEvent(new Event('statechange'));
	}
}

const song = (id: string, duration = 200) => ({ id, title: id, duration }) as Song;
const flush = () => new Promise((r) => setTimeout(r, 0));

async function freshPlayer() {
	vi.resetModules();
	delete (globalThis as { __musicPlayer?: unknown }).__musicPlayer;
	const { getPlayer } = await import('./player.svelte');
	const player = getPlayer();
	return { player, audio: FakeAudio.last };
}

let session: FakeAudioSession;

beforeEach(() => {
	localStorage.clear();
	vi.stubGlobal('Audio', FakeAudio);
	session = new FakeAudioSession();
	Object.defineProperty(navigator, 'audioSession', { value: session, configurable: true });
	sleepTimer.onTrackEnded.mockReturnValue(false);
	let n = 0;
	URL.createObjectURL = vi.fn(() => `blob:test/${++n}`);
	URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
	(globalThis as { __musicPlayer?: { destroy(): void } }).__musicPlayer?.destroy();
	vi.unstubAllGlobals();
});

describe('Player track changes', () => {
	it('starts the tapped song', async () => {
		const { player, audio } = await freshPlayer();
		player.playList([song('a'), song('b'), song('c')], 1);
		await flush();
		expect(player.current?.id).toBe('b');
		expect(audio.src).toContain('id=b');
		expect(audio.play).toHaveBeenCalled();
		expect(session.type).toBe('playback');
	});

	it('moves to the next song synchronously on ended', async () => {
		const { player, audio } = await freshPlayer();
		player.playList([song('a'), song('b')]);
		await flush();
		audio.fire('ended');
		// No await: the src must already be set.
		expect(player.current?.id).toBe('b');
		expect(audio.src).toContain('id=b');
	});

	it('plays the prefetched copy when the song ends, without fetching again', async () => {
		const fetchMock = vi.fn(async () => new Response('audio'));
		vi.stubGlobal('fetch', fetchMock);
		const { player, audio } = await freshPlayer();
		player.playList([song('a'), song('b')]);
		await flush();
		audio.duration = 200;
		audio.fire('durationchange');
		for (const t of [170, 170.25, 170.5]) {
			audio.currentTime = t;
			audio.fire('timeupdate');
		}
		await flush();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		audio.fire('ended');
		expect(audio.src).toMatch(/^blob:test\//);
	});

	it('does not prefetch before the last 45 seconds', async () => {
		const fetchMock = vi.fn(async () => new Response('audio'));
		vi.stubGlobal('fetch', fetchMock);
		const { player, audio } = await freshPlayer();
		player.playList([song('a'), song('b')]);
		await flush();
		audio.duration = 200;
		audio.currentTime = 100;
		audio.fire('timeupdate');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('restarts the same song on repeat-one', async () => {
		const { player, audio } = await freshPlayer();
		player.playList([song('a'), song('b')]);
		await flush();
		player.cycleRepeat();
		player.cycleRepeat();
		expect(player.repeat).toBe('one');
		audio.currentTime = 200;
		audio.play.mockClear();
		audio.fire('ended');
		expect(player.current?.id).toBe('a');
		expect(audio.currentTime).toBe(0);
		expect(audio.play).toHaveBeenCalled();
	});

	it('stops at the end of the queue with repeat off', async () => {
		const { player, audio } = await freshPlayer();
		player.playList([song('a')]);
		await flush();
		audio.fire('ended');
		expect(player.current?.id).toBe('a');
		expect(player.currentTime).toBe(0);
	});

	it('honours the sleep timer ending at the track end', async () => {
		const { player, audio } = await freshPlayer();
		player.playList([song('a'), song('b')]);
		await flush();
		sleepTimer.onTrackEnded.mockReturnValue(true);
		audio.fire('ended');
		expect(player.current?.id).toBe('a');
	});

	it('ends at the server length when iOS reports about double', async () => {
		const { player, audio } = await freshPlayer();
		player.playList([song('a', 200), song('b')]);
		await flush();
		audio.duration = 400;
		audio.fire('durationchange');
		expect(player.duration).toBe(200);
		audio.currentTime = 199.8;
		audio.fire('timeupdate');
		expect(player.current?.id).toBe('b');
	});

	it('does not advance twice when a capped end is followed by native ended', async () => {
		const { player, audio } = await freshPlayer();
		player.playList([song('a'), song('b'), song('c')]);
		await flush();
		audio.duration = 400;
		audio.fire('durationchange');
		audio.currentTime = 199.8;
		audio.fire('timeupdate');
		expect(player.current?.id).toBe('b');

		// Some mobile engines still dispatch the old element's ended notification.
		audio.fire('ended');
		expect(player.current?.id).toBe('b');
	});
});

describe('Player interruptions', () => {
	it('pauses for a call and resumes afterwards', async () => {
		const { player, audio } = await freshPlayer();
		player.playList([song('a')]);
		await flush();
		expect(audio.paused).toBe(false);
		session.set('interrupted');
		expect(audio.paused).toBe(true);
		expect(player.playing).toBe(false);
		audio.play.mockClear();
		session.set('active');
		expect(audio.play).toHaveBeenCalledTimes(1);
	});

	it('stays paused after the call when the user paused during it', async () => {
		const { player, audio } = await freshPlayer();
		player.playList([song('a')]);
		await flush();
		session.set('interrupted');
		player.pause();
		audio.play.mockClear();
		session.set('active');
		expect(audio.play).not.toHaveBeenCalled();
	});

	it('pauses when the page is torn down', async () => {
		const { player, audio } = await freshPlayer();
		player.playList([song('a')]);
		await flush();
		window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
		expect(audio.paused).toBe(true);
		expect(player.playing).toBe(false);
	});
});

describe('Player queue edits', () => {
	it('keeps the current song when removing and moving others', async () => {
		const { player } = await freshPlayer();
		player.playList([song('a'), song('b'), song('c'), song('d')], 2);
		await flush();
		player.removeAt(0);
		expect(player.current?.id).toBe('c');
		player.moveUpNext(2, 0);
		expect(player.queue.map((s) => s.id)).toEqual(['d', 'b', 'c']);
		expect(player.current?.id).toBe('c');
	});

	it('restores the original order when shuffle is turned off', async () => {
		const { player } = await freshPlayer();
		player.playList([song('a'), song('b'), song('c'), song('d')], 1);
		await flush();
		player.toggleShuffle();
		expect(player.queue[0].id).toBe('b');
		player.toggleShuffle();
		expect(player.queue.map((s) => s.id)).toEqual(['a', 'b', 'c', 'd']);
		expect(player.current?.id).toBe('b');
	});
});
