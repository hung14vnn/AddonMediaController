// Track-change paths of the Player, driven through a fake <audio> (jsdom has no media
// playback).
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
	readyState = 0;
	error: { code: number; message: string } | null = null;
	src = '';
	/** Like the media element load algorithm: drop the data and stop. */
	load = vi.fn(() => {
		this.readyState = 0;
		this.error = null;
		this.paused = true;
	});
	play = vi.fn(() => {
		this.paused = false;
		this.dispatchEvent(new Event('play'));
		if (this.readyState < 3) this.dispatchEvent(new Event('waiting'));
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
	/** The new source has data: `canplay`. */
	ready() {
		this.readyState = 4;
		this.fire('canplay');
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

beforeEach(() => {
	localStorage.clear();
	vi.stubGlobal('Audio', FakeAudio);
	vi.stubGlobal('fetch', vi.fn(async () => new Response('')));
	let n = 0;
	URL.createObjectURL = vi.fn(() => `blob:test/${++n}`);
	URL.revokeObjectURL = vi.fn();
	sleepTimer.onTrackEnded.mockReturnValue(false);
});

afterEach(() => {
	(globalThis as { __musicPlayer?: { destroy(): void } }).__musicPlayer?.destroy();
	vi.unstubAllGlobals();
});

describe('Player track changes', () => {
	it('starts the tapped song: set src, load(), play(), spinner until canplay', async () => {
		const { player, audio } = await freshPlayer();
		player.playList([song('a'), song('b'), song('c')], 1);
		await flush();
		expect(player.current?.id).toBe('b');
		expect(audio.src).toContain('id=b');
		expect(audio.load).toHaveBeenCalled();
		// play() at once keeps the audio session alive while the source loads.
		expect(audio.play).toHaveBeenCalledTimes(1);
		expect(player.buffering).toBe(true);
		expect(player.active).toBe(true);
		audio.ready();
		expect(player.playing).toBe(true);
		expect(player.buffering).toBe(false);
	});

	it('plays on canplay when the early play() did not stick', async () => {
		const { player, audio } = await freshPlayer();
		player.playList([song('a')]);
		await flush();
		audio.paused = true;
		audio.play.mockClear();
		audio.ready();
		expect(audio.play).toHaveBeenCalledTimes(1);
		expect(player.current?.id).toBe('a');
	});

	it('retries a play() refused in the background once the app is visible', async () => {
		const { player, audio } = await freshPlayer();
		player.playList([song('a'), song('b')]);
		await flush();
		audio.ready();
		const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
		try {
			audio.play.mockImplementationOnce(() => Promise.reject(new DOMException('blocked', 'NotAllowedError')));
			audio.fire('ended');
			await flush();
			expect(player.current?.id).toBe('b');
			expect(player.active).toBe(false);
			audio.play.mockClear();
			hidden.mockReturnValue(false);
			document.dispatchEvent(new Event('visibilitychange'));
			expect(audio.play).toHaveBeenCalledTimes(1);
		} finally {
			vi.restoreAllMocks();
		}
	});

	it('downloads the next track in the last 45 seconds and plays it from memory', async () => {
		const fetchMock = vi.fn(async () => new Response('audio'));
		vi.stubGlobal('fetch', fetchMock);
		const { player, audio } = await freshPlayer();
		player.playList([song('a', 200), song('b')]);
		await flush();
		audio.ready();
		audio.currentTime = 100;
		audio.fire('timeupdate');
		expect(fetchMock).not.toHaveBeenCalled();
		for (const t of [160, 161, 162]) {
			audio.currentTime = t;
			audio.fire('timeupdate');
		}
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('id=b'));
		await flush();
		await flush();
		// The network may be gone by now: the change must not need it.
		audio.fire('ended');
		expect(player.current?.id).toBe('b');
		expect(audio.src).toMatch(/^blob:test\//);
	});

	it('waits for the app to be opened when the next track fails in the background', async () => {
		const { player, audio } = await freshPlayer();
		player.playList([song('a'), song('b'), song('c')]);
		await flush();
		audio.ready();
		const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
		try {
			audio.fire('ended');
			expect(player.current?.id).toBe('b');
			audio.load.mockClear();
			audio.error = { code: 4, message: 'Format error' };
			audio.fire('error');
			await flush();
			// No skipping through the queue while the network is cut.
			expect(player.current?.id).toBe('b');
			expect(audio.load).not.toHaveBeenCalled();
			expect(player.active).toBe(false);
			hidden.mockReturnValue(false);
			document.dispatchEvent(new Event('visibilitychange'));
			await flush();
			expect(player.current?.id).toBe('b');
			expect(audio.load).toHaveBeenCalledTimes(1);
			expect(audio.play).toHaveBeenCalled();
		} finally {
			vi.restoreAllMocks();
		}
	});

	it('kicks a waiting element that already has enough data', async () => {
		const { player, audio } = await freshPlayer();
		player.playList([song('a')]);
		await flush();
		audio.ready();
		audio.play.mockClear();
		audio.fire('waiting');
		expect(audio.play).toHaveBeenCalledTimes(1);
		expect(player.current?.id).toBe('a');
	});

	it('shows paused, not playing, when the browser refuses play()', async () => {
		const { player, audio } = await freshPlayer();
		audio.play.mockImplementationOnce(() => Promise.reject(new DOMException('blocked', 'NotAllowedError')));
		player.playList([song('a')]);
		await flush();
		expect(player.playing).toBe(false);
		expect(player.buffering).toBe(false);
		expect(player.active).toBe(false);
	});

	it('does not start by itself on canplay after the user paused', async () => {
		const { player, audio } = await freshPlayer();
		player.playList([song('a')]);
		await flush();
		player.pause();
		audio.play.mockClear();
		audio.ready();
		expect(audio.play).not.toHaveBeenCalled();
		expect(player.active).toBe(false);
	});

	it('moves to the next song on ended', async () => {
		const { player, audio } = await freshPlayer();
		player.playList([song('a'), song('b')]);
		await flush();
		audio.fire('ended');
		await flush();
		expect(player.current?.id).toBe('b');
		expect(audio.src).toContain('id=b');
	});

	it('keeps only the latest of two quick track changes', async () => {
		const { player, audio } = await freshPlayer();
		player.playList([song('a'), song('b'), song('c')]);
		player.jumpTo(2);
		await flush();
		expect(player.current?.id).toBe('c');
		expect(audio.src).toContain('id=c');
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
		await flush();
		expect(player.current?.id).toBe('a');
	});

	it('takes the duration from the media element once known', async () => {
		const { player, audio } = await freshPlayer();
		player.playList([song('a', 200)]);
		await flush();
		audio.duration = 201.5;
		audio.fire('durationchange');
		expect(player.duration).toBe(201.5);
	});
});

describe('Player platform fixes', () => {
	it('ends at the server length when iOS reports about double, advancing once', async () => {
		const { player, audio } = await freshPlayer();
		player.playList([song('a', 200), song('b'), song('c')]);
		await flush();
		audio.ready();
		audio.duration = 400;
		audio.fire('durationchange');
		expect(player.duration).toBe(200);
		audio.currentTime = 199.8;
		audio.fire('timeupdate');
		await flush();
		expect(player.current?.id).toBe('b');
		// A stale native ended for the old source must not skip 'b'.
		audio.fire('ended');
		await flush();
		expect(player.current?.id).toBe('c');
	});

	it('reloads at the current position when the clock freezes while playing', async () => {
		vi.useFakeTimers();
		try {
			const { player, audio } = await freshPlayer();
			player.playList([song('a')]);
			await vi.advanceTimersByTimeAsync(0);
			audio.ready();
			audio.currentTime = 42;
			audio.fire('timeupdate');
			audio.load.mockClear();
			await vi.advanceTimersByTimeAsync(10_000);
			expect(audio.load).toHaveBeenCalled();
			expect(player.current?.id).toBe('a');
			expect(player.currentTime).toBe(42);
		} finally {
			vi.useRealTimers();
		}
	});

	it('reloads a next track that never reaches canplay', async () => {
		vi.useFakeTimers();
		try {
			const { player, audio } = await freshPlayer();
			player.playList([song('a'), song('b')]);
			await vi.advanceTimersByTimeAsync(0);
			audio.ready();
			audio.fire('ended');
			await vi.advanceTimersByTimeAsync(0);
			audio.load.mockClear();
			await vi.advanceTimersByTimeAsync(10_000);
			expect(audio.load).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(15_000);
			expect(player.current?.id).toBe('b');
			expect(audio.load).toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not reload while paused for a call', async () => {
		vi.useFakeTimers();
		const session = new FakeAudioSession();
		Object.defineProperty(navigator, 'audioSession', { value: session, configurable: true });
		try {
			const { player, audio } = await freshPlayer();
			player.playList([song('a')]);
			await vi.advanceTimersByTimeAsync(0);
			audio.ready();
			session.set('interrupted');
			audio.load.mockClear();
			await vi.advanceTimersByTimeAsync(30_000);
			expect(audio.load).not.toHaveBeenCalled();
			expect(audio.paused).toBe(true);
			expect(player.current?.id).toBe('a');
		} finally {
			delete (navigator as { audioSession?: unknown }).audioSession;
			vi.useRealTimers();
		}
	});

	it('pauses for a call and resumes afterwards', async () => {
		const session = new FakeAudioSession();
		Object.defineProperty(navigator, 'audioSession', { value: session, configurable: true });
		try {
			const { player, audio } = await freshPlayer();
			expect(session.type).toBe('playback');
			player.playList([song('a')]);
			await flush();
			audio.ready();
			session.set('interrupted');
			expect(audio.paused).toBe(true);
			audio.play.mockClear();
			session.set('active');
			expect(audio.play).toHaveBeenCalledTimes(1);
		} finally {
			delete (navigator as { audioSession?: unknown }).audioSession;
		}
	});

	it('stays paused after the call when the user paused during it', async () => {
		const session = new FakeAudioSession();
		Object.defineProperty(navigator, 'audioSession', { value: session, configurable: true });
		try {
			const { player, audio } = await freshPlayer();
			player.playList([song('a')]);
			await flush();
			audio.ready();
			session.set('interrupted');
			player.pause();
			audio.play.mockClear();
			session.set('active');
			expect(audio.play).not.toHaveBeenCalled();
		} finally {
			delete (navigator as { audioSession?: unknown }).audioSession;
		}
	});

	it('changes track synchronously while hidden instead of awaiting IndexedDB', async () => {
		const { player, audio } = await freshPlayer();
		player.playList([song('a'), song('b')]);
		await flush();
		vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
		try {
			audio.fire('ended');
			// No await: the src must already be set.
			expect(audio.src).toContain('id=b');
		} finally {
			vi.restoreAllMocks();
		}
	});
});

describe('Player media errors', () => {
	it('reloads a failed track once, then skips to the next', async () => {
		const { player, audio } = await freshPlayer();
		player.playList([song('a'), song('b')]);
		await flush();
		audio.load.mockClear();
		audio.fire('error');
		await flush();
		expect(player.current?.id).toBe('a');
		expect(audio.load).toHaveBeenCalledTimes(1);
		audio.fire('error');
		await flush();
		expect(player.current?.id).toBe('b');
		expect(audio.src).toContain('id=b');
	});

	it('stops after a few unplayable tracks in a row', async () => {
		const { player, audio } = await freshPlayer();
		player.repeat = 'all';
		player.playList([song('a'), song('b')]);
		await flush();
		for (let i = 0; i < 20; i++) {
			audio.fire('error');
			await flush();
		}
		expect(audio.load.mock.calls.length).toBeLessThan(12);
		expect(player.error).not.toBeNull();
		expect(player.active).toBe(false);
	});
});

describe('Player unload', () => {
	it('releases the source on sign-out', async () => {
		const { player, audio } = await freshPlayer();
		player.playList([song('a')]);
		await flush();
		player.reset();
		expect(audio.paused).toBe(true);
		expect(audio.src).toBe('');
		expect(player.current).toBeNull();
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
