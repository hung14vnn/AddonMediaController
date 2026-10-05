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
	autoplay = false;
	ended = false;
	style: Record<string, string> = {};
	remove = vi.fn();
	static all: FakeAudio[] = [];
	constructor() {
		super();
		FakeAudio.last = this;
		FakeAudio.all.push(this);
	}
	setAttribute() {}
	getAttribute(name: string) {
		return name === 'src' && this.src ? this.src : null;
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
/** A response big enough to pass the prefetch's "not an error page" check. */
const audioResponse = () => new Response(new Uint8Array(20_000));

/** Play to `t` seconds on `audio`, as the element's clock would report it. */
function playTo(audio: FakeAudio, t: number) {
	audio.currentTime = t;
	audio.fire('timeupdate');
}

async function freshPlayer() {
	vi.resetModules();
	delete (globalThis as { __musicPlayer?: unknown }).__musicPlayer;
	const { getPlayer } = await import('./player.svelte');
	const player = getPlayer();
	return { player, audio: FakeAudio.last };
}

beforeEach(() => {
	localStorage.clear();
	FakeAudio.all = [];
	vi.stubGlobal('Audio', FakeAudio);
	// The player mounts its elements in the document; the fake is not a DOM node.
	vi.spyOn(document.body, 'appendChild').mockImplementation((n) => n);
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
		// A play() that hasn't settled yet: the source is still loading.
		audio.play.mockImplementationOnce(() => {
			audio.paused = false;
			audio.fire('play');
			audio.fire('waiting');
			return new Promise(() => {});
		});
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

	it('downloads the next track in the last 150 seconds and plays it from memory', async () => {
		const fetchMock = vi.fn(async () => audioResponse());
		vi.stubGlobal('fetch', fetchMock);
		const { player, audio } = await freshPlayer();
		player.playList([song('a', 200), song('b')]);
		await flush();
		audio.ready();
		playTo(audio, 40);
		expect(fetchMock).not.toHaveBeenCalled();
		for (const t of [60, 61, 62]) playTo(audio, t);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('id=b'), expect.anything());
		await flush();
		await flush();
		// The network may be gone by now: the change must not need it.
		audio.fire('ended');
		expect(player.current?.id).toBe('b');
		const active = FakeAudio.all.find((a) => a.src.startsWith('blob:') && !a.paused);
		expect(active).toBeDefined();
	});

	it('retries a track that fails in the background after a pause, not at once', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
		const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
		try {
			const { player, audio } = await freshPlayer();
			player.playList([song('a'), song('b'), song('c')]);
			await vi.advanceTimersByTimeAsync(0);
			audio.ready();
			audio.fire('ended');
			await vi.advanceTimersByTimeAsync(0);
			expect(player.current?.id).toBe('b');
			audio.load.mockClear();
			audio.error = { code: 4, message: 'Format error' };
			audio.fire('error');
			await vi.advanceTimersByTimeAsync(0);
			expect(audio.load).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(2_000);
			expect(player.current?.id).toBe('b');
			expect(audio.load).toHaveBeenCalledTimes(1);
		} finally {
			hidden.mockRestore();
			vi.useRealTimers();
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
		// No pause in between: on a hidden iOS page it ends the audio session and the
		// next track never loads.
		expect(audio.pause).not.toHaveBeenCalled();
		// A stale native ended for the old source must not skip 'b'.
		audio.fire('ended');
		await flush();
		expect(player.current?.id).toBe('c');
	});

	it('reloads at the current position when the clock freezes while playing', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
		try {
			const { player, audio } = await freshPlayer();
			player.playList([song('a')]);
			await vi.advanceTimersByTimeAsync(0);
			audio.ready();
			audio.currentTime = 42;
			audio.fire('timeupdate');
			audio.load.mockClear();
			await vi.advanceTimersByTimeAsync(10_000);
			expect(audio.load).not.toHaveBeenCalled();
			// 15 s without progress, then the 2 s error delay.
			await vi.advanceTimersByTimeAsync(10_000);
			expect(audio.load).toHaveBeenCalled();
			expect(player.current?.id).toBe('a');
			expect(player.currentTime).toBe(42);
		} finally {
			vi.useRealTimers();
		}
	});

	it('freezes the UI clock while hidden but keeps the real position for recovery', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
		const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
		try {
			const { player, audio } = await freshPlayer();
			player.playList([song('a')]);
			await vi.advanceTimersByTimeAsync(0);
			audio.ready();
			audio.currentTime = 5;
			audio.fire('timeupdate');
			expect(player.currentTime).toBe(5);

			hidden.mockReturnValue(true);
			document.dispatchEvent(new Event('visibilitychange'));
			audio.currentTime = 30;
			audio.fire('timeupdate');
			// No reactive UI work with the screen off...
			expect(player.currentTime).toBe(5);
			// ...but the engine still knows where playback is, e.g. for the snapshot
			// written when the hidden page is closed.
			expect(player.position).toBe(30);
			window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
			expect(JSON.parse(localStorage.getItem('music.queue')!).time).toBe(30);

			hidden.mockReturnValue(false);
			document.dispatchEvent(new Event('visibilitychange'));
			expect(player.currentTime).toBe(30);

		} finally {
			hidden.mockRestore();
			vi.useRealTimers();
		}
	});

	it('keeps playing through long steady progress, then still catches a freeze', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
		try {
			const { player, audio } = await freshPlayer();
			player.playList([song('a')]);
			await vi.advanceTimersByTimeAsync(0);
			audio.ready();
			audio.load.mockClear();
			// A minute of normal playback: the self-rescheduling watchdog must not fire.
			for (let t = 1; t <= 60; t++) {
				audio.currentTime = t;
				audio.fire('timeupdate');
				await vi.advanceTimersByTimeAsync(1_000);
			}
			expect(audio.load).not.toHaveBeenCalled();
			// Then the clock freezes: 15 s quiet (+ up to one 2 s re-check) + the 2 s error delay.
			await vi.advanceTimersByTimeAsync(20_000);
			expect(audio.load).toHaveBeenCalled();
			expect(player.currentTime).toBe(60);
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not count hidden time as a stall when the app comes back', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
		const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
		try {
			const { player, audio } = await freshPlayer();
			player.playList([song('a')]);
			await vi.advanceTimersByTimeAsync(0);
			audio.ready();
			audio.currentTime = 10;
			audio.fire('timeupdate');
			audio.load.mockClear();
			// No progress while hidden (WebKit may suspend loading), shown again just
			// before the watchdog's next check: resuming re-arms it (play() resets the
			// clock), so the hidden stretch must not count towards the 15 s.
			hidden.mockReturnValue(true);
			document.dispatchEvent(new Event('visibilitychange'));
			await vi.advanceTimersByTimeAsync(14_000);
			hidden.mockReturnValue(false);
			document.dispatchEvent(new Event('visibilitychange'));
			await vi.advanceTimersByTimeAsync(5_000);
			expect(audio.load).not.toHaveBeenCalled();
			expect(player.current?.id).toBe('a');
		} finally {
			hidden.mockRestore();
			vi.useRealTimers();
		}
	});

	it('ignores a stall callback iOS queued before the app was hidden', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
		const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
		const nativeSetTimeout = globalThis.setTimeout;
		const stalledCallbacks: (() => void)[] = [];
		const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
			if (delay === 15_000 && typeof callback === 'function') stalledCallbacks.push(callback as () => void);
			return nativeSetTimeout(callback, delay, ...args);
		}) as typeof setTimeout);
		try {
			const { player, audio } = await freshPlayer();
			player.playList([song('a')]);
			await vi.advanceTimersByTimeAsync(0);
			audio.ready();
			expect(stalledCallbacks).toHaveLength(1);

			hidden.mockReturnValue(true);
			document.dispatchEvent(new Event('visibilitychange'));
			hidden.mockReturnValue(false);
			document.dispatchEvent(new Event('visibilitychange'));
			audio.pause.mockClear();
			// Safari may deliver this callback even after clearTimeout() if it had
			// already queued it while the app was being backgrounded.
			stalledCallbacks[0]();
			expect(audio.pause).not.toHaveBeenCalled();
			expect(player.current?.id).toBe('a');
		} finally {
			setTimeoutSpy.mockRestore();
			hidden.mockRestore();
			vi.useRealTimers();
		}
	});

	it('reloads a next track that never reaches canplay', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
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
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
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

describe('Player background track changes', () => {
	/** Plays 'a' until the next track 'b' is downloaded and loaded into the standby element. */
	async function withStandby() {
		vi.stubGlobal('fetch', vi.fn(async () => audioResponse()));
		const { player, audio } = await freshPlayer();
		player.playList([song('a', 200), song('b'), song('c')]);
		await flush();
		audio.ready();
		audio.fire('playing');
		playTo(audio, 100);
		await flush();
		await flush();
		return { player, audio };
	}

	it('Android: starts the next track on a standby element before the current one ends', async () => {
		const { player, audio } = await withStandby();
		expect(FakeAudio.all).toHaveLength(2);
		const standby = FakeAudio.all[1];
		expect(standby.src).toMatch(/^blob:test\//);
		expect(standby.paused).toBe(true);

		playTo(audio, 199.6);
		expect(player.current?.id).toBe('b');
		expect(standby.play).toHaveBeenCalled();
		// The old element plays on until the new one actually plays: never a silent moment.
		expect(audio.paused).toBe(false);
		standby.ready();
		standby.fire('playing');
		expect(audio.paused).toBe(true);
		expect(audio.src).toBe('');
	});

	it('Android: ignores the old element after the handoff', async () => {
		const { player, audio } = await withStandby();
		playTo(audio, 199.6);
		// Its own late `ended` must not skip 'b'.
		audio.fire('ended');
		await flush();
		expect(player.current?.id).toBe('b');
	});

	it('iOS: keeps a single element and swaps its source', async () => {
		vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)');
		try {
			const { player, audio } = await withStandby();
			expect(FakeAudio.all).toHaveLength(1);
			audio.fire('ended');
			expect(player.current?.id).toBe('b');
			expect(audio.src).toMatch(/^blob:test\//);
		} finally {
			vi.restoreAllMocks();
		}
	});

	it('Android: streams the next track on standby when its download is too slow', async () => {
		let signal: AbortSignal | undefined;
		vi.stubGlobal(
			'fetch',
			vi.fn((_url: string, init?: RequestInit) => {
				signal = init?.signal ?? undefined;
				return new Promise<Response>(() => {});
			})
		);
		const { player, audio } = await freshPlayer();
		player.playList([song('a', 200), song('b'), song('c')]);
		await flush();
		audio.ready();
		playTo(audio, 100);
		expect(FakeAudio.all).toHaveLength(1);
		playTo(audio, 160);
		// The download is dropped and the stream goes on standby instead.
		expect(signal?.aborted).toBe(true);
		const standby = FakeAudio.all[1];
		expect(standby.src).toContain('id=b');
		expect(standby.paused).toBe(true);
		playTo(audio, 199.5);
		expect(player.current?.id).toBe('b');
		expect(standby.play).toHaveBeenCalled();
		expect(audio.paused).toBe(false);
		standby.ready();
		standby.fire('playing');
		expect(audio.paused).toBe(true);
	});

	it('iOS: never streams on standby', async () => {
		vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)');
		vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
		try {
			const { player, audio } = await freshPlayer();
			player.playList([song('a', 200), song('b')]);
			await flush();
			audio.ready();
			playTo(audio, 199.5);
			expect(FakeAudio.all).toHaveLength(1);
		} finally {
			vi.restoreAllMocks();
		}
	});

	it('cancels the next-track download when that track starts streaming first', async () => {
		let signal: AbortSignal | undefined;
		vi.stubGlobal(
			'fetch',
			vi.fn((_url: string, init?: RequestInit) => {
				signal = init?.signal ?? undefined;
				return new Promise<Response>(() => {});
			})
		);
		const { player, audio } = await freshPlayer();
		player.playList([song('a', 200), song('b')]);
		await flush();
		audio.ready();
		playTo(audio, 100);
		expect(signal?.aborted).toBe(false);
		audio.fire('ended');
		expect(player.current?.id).toBe('b');
		expect(signal?.aborted).toBe(true);
	});

	it('resumes when the app is opened after the system paused a track that just started', async () => {
		const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
		try {
			const { player, audio } = await freshPlayer();
			player.playList([song('a'), song('b')]);
			await flush();
			audio.ready();
			audio.fire('playing');
			// Not requested by the page: Android refusing audio focus.
			audio.pause();
			expect(player.playing).toBe(false);
			audio.play.mockClear();
			hidden.mockReturnValue(false);
			document.dispatchEvent(new Event('visibilitychange'));
			expect(audio.play).toHaveBeenCalledTimes(1);
		} finally {
			hidden.mockRestore();
		}
	});

	it('stays paused after a later system pause, like headphones unplugged', async () => {
		const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
		const now = vi.spyOn(performance, 'now');
		try {
			const { player, audio } = await freshPlayer();
			player.playList([song('a'), song('b')]);
			await flush();
			audio.ready();
			now.mockReturnValue(1_000);
			audio.fire('playing');
			now.mockReturnValue(61_000);
			audio.pause();
			audio.play.mockClear();
			hidden.mockReturnValue(false);
			document.dispatchEvent(new Event('visibilitychange'));
			expect(audio.play).not.toHaveBeenCalled();
			expect(player.playing).toBe(false);
		} finally {
			hidden.mockRestore();
			now.mockRestore();
		}
	});
});

describe('Player media errors', () => {
	it('reloads a failed track once, then skips to the next', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
		try {
			const { player, audio } = await freshPlayer();
			player.playList([song('a'), song('b')]);
			await vi.advanceTimersByTimeAsync(0);
			audio.load.mockClear();
			audio.fire('error');
			await vi.advanceTimersByTimeAsync(2_000);
			expect(player.current?.id).toBe('a');
			expect(audio.load).toHaveBeenCalledTimes(1);
			audio.fire('error');
			await vi.advanceTimersByTimeAsync(2_000);
			expect(player.current?.id).toBe('b');
			expect(audio.src).toContain('id=b');
		} finally {
			vi.useRealTimers();
		}
	});

	it('stops after a few unplayable tracks in a row', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
		try {
			const { player, audio } = await freshPlayer();
			player.repeat = 'all';
			player.playList([song('a'), song('b')]);
			await vi.advanceTimersByTimeAsync(0);
			for (let i = 0; i < 20; i++) {
				audio.error = { code: 4, message: 'Format error' };
				audio.fire('error');
				await vi.advanceTimersByTimeAsync(2_500);
			}
			expect(audio.load.mock.calls.length).toBeLessThan(12);
			expect(player.error).not.toBeNull();
			expect(player.active).toBe(false);
		} finally {
			vi.useRealTimers();
		}
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
