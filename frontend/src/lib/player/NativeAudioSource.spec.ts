import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
	const listeners = new Map<string, Set<EventListener>>();
	const resumeAudioEngine = vi.fn(async () => undefined);
	const suspendAudioEngine = vi.fn(async () => undefined);
	const audio = {
		src: '',
		crossOrigin: '',
		autoplay: false,
		preload: 'auto',
		volume: 1,
		currentTime: 0,
		duration: 180,
		ended: false,
		error: null as MediaError | null,
		play: vi.fn(() => Promise.resolve()),
		pause: vi.fn(),
		load: vi.fn(),
		addEventListener: vi.fn((event: string, handler: EventListener) => {
			const set = listeners.get(event) ?? new Set<EventListener>();
			set.add(handler);
			listeners.set(event, set);
		}),
		removeEventListener: vi.fn((event: string, handler: EventListener) => {
			listeners.get(event)?.delete(handler);
		})
	};

	const dispatch = (event: string): void => {
		for (const handler of listeners.get(event) ?? []) {
			handler(new Event(event));
		}
	};

	const reset = (): void => {
		listeners.clear();
		audio.src = '';
		audio.crossOrigin = '';
		audio.autoplay = false;
		audio.preload = 'auto';
		audio.volume = 1;
		audio.currentTime = 0;
		audio.duration = 180;
		audio.ended = false;
		audio.error = null;
		audio.play.mockReset();
		audio.play.mockImplementation(() => Promise.resolve());
		audio.pause.mockReset();
		audio.load.mockReset();
		audio.addEventListener.mockClear();
		audio.removeEventListener.mockClear();
		resumeAudioEngine.mockReset();
		resumeAudioEngine.mockResolvedValue(undefined);
		suspendAudioEngine.mockReset();
		suspendAudioEngine.mockResolvedValue(undefined);
	};

	return {
		audio,
		dispatch,
		reset,
		getAudioElement: vi.fn(() => audio as unknown as HTMLAudioElement),
		resumeAudioEngine,
		suspendAudioEngine
	};
});

vi.mock('./audioElement', () => ({
	getAudioElement: hoisted.getAudioElement,
	resumeAudioEngine: hoisted.resumeAudioEngine,
	suspendAudioEngine: hoisted.suspendAudioEngine
}));

import { NativeAudioSource } from './NativeAudioSource';

describe('NativeAudioSource', () => {
	beforeEach(() => {
		hoisted.reset();
		hoisted.getAudioElement.mockImplementation(() => hoisted.audio as unknown as HTMLAudioElement);
		vi.useRealTimers();
	});

	it('loads successfully on canplay', async () => {
		const source = new NativeAudioSource('local', { url: '/audio.mp3', seekable: true });
		const loadPromise = source.load();

		expect(hoisted.audio.src).toBe('/audio.mp3');
		expect(hoisted.audio.crossOrigin).toBe('use-credentials');
		hoisted.dispatch('canplay');

		await expect(loadPromise).resolves.toBeUndefined();
	});

	it('keeps autoplay enabled for a background Media Session track change', async () => {
		const source = new NativeAudioSource('local', { url: '/next.mp3', seekable: true });
		const loadPromise = source.load({ autoplay: true });

		expect(hoisted.audio.autoplay).toBe(true);
		expect(hoisted.audio.preload).toBe('auto');
		hoisted.dispatch('canplay');

		await expect(loadPromise).resolves.toBeUndefined();
	});

	it('loads successfully on metadata and reports duration before playback timeupdates', async () => {
		const source = new NativeAudioSource('local', { url: '/metadata.mp3', seekable: true });
		const onProgress = vi.fn();
		source.onProgress(onProgress);
		const loadPromise = source.load();

		hoisted.audio.duration = 178;
		hoisted.dispatch('loadedmetadata');

		await expect(loadPromise).resolves.toBeUndefined();
		expect(onProgress).toHaveBeenCalledWith(0, 178);
	});

	it('fires onReady only once even if every ready event arrives', async () => {
		const source = new NativeAudioSource('local', { url: '/single-shot.mp3', seekable: true });
		const onReady = vi.fn();
		source.onReady(onReady);

		const loadPromise = source.load();
		hoisted.dispatch('canplay');
		await loadPromise;

		expect(onReady).toHaveBeenCalledTimes(1);

		// The later ready events must not re-enter onReady, however the
		// listeners happen to be detached.
		hoisted.dispatch('loadedmetadata');
		hoisted.dispatch('loadeddata');
		expect(onReady).toHaveBeenCalledTimes(1);
	});

	it('fails load when timeout is reached', async () => {
		vi.useFakeTimers();
		const source = new NativeAudioSource('local', { url: '/timeout.mp3', seekable: true });
		const loadPromise = source.load();

		vi.advanceTimersByTime(15_000);

		await expect(loadPromise).rejects.toThrow('load timed out');
	});

	it('emits network stall error after stalled timeout', async () => {
		vi.useFakeTimers();
		const source = new NativeAudioSource('local', { url: '/stall.mp3', seekable: true });
		const onError = vi.fn();
		source.onError(onError);

		const loadPromise = source.load();
		hoisted.dispatch('canplay');
		await loadPromise;

		hoisted.dispatch('stalled');
		vi.advanceTimersByTime(15_000);

		expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'NETWORK_STALL' }));
	});

	it('reports autoplay blocked when play promise rejects', async () => {
		const source = new NativeAudioSource('local', { url: '/blocked.mp3', seekable: true });
		const onError = vi.fn();
		source.onError(onError);

		hoisted.audio.play.mockImplementationOnce(() =>
			Promise.reject(new DOMException('blocked', 'NotAllowedError'))
		);
		source.play();
		await Promise.resolve();
		await Promise.resolve();

		expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'AUTOPLAY_BLOCKED' }));
	});

	it('reports play failed when play promise rejects without NotAllowedError', async () => {
		const source = new NativeAudioSource('local', { url: '/failed.mp3', seekable: true });
		const onError = vi.fn();
		source.onError(onError);

		hoisted.audio.play.mockImplementationOnce(() =>
			Promise.reject(new DOMException('aborted', 'AbortError'))
		);
		source.play();
		await Promise.resolve();
		await Promise.resolve();

		expect(onError).toHaveBeenCalledWith(
			expect.objectContaining({
				code: 'PLAY_FAILED',
				message: expect.stringContaining('server may not have responded')
			})
		);
	});

	it('resumes the Web Audio engine before native playback', async () => {
		const source = new NativeAudioSource('local', { url: '/resume.mp3', seekable: true });

		source.play();
		await Promise.resolve();
		await Promise.resolve();

		expect(hoisted.resumeAudioEngine).toHaveBeenCalledTimes(1);
		expect(hoisted.audio.play).toHaveBeenCalledTimes(1);
		expect(hoisted.audio.play.mock.invocationCallOrder[0]).toBeLessThan(
			hoisted.resumeAudioEngine.mock.invocationCallOrder[0]
		);
	});

	it('still attempts native playback if Web Audio resume rejects', async () => {
		const source = new NativeAudioSource('local', { url: '/resume-rejected.mp3', seekable: true });

		hoisted.resumeAudioEngine.mockRejectedValueOnce(new Error('resume blocked'));
		source.play();
		await Promise.resolve();
		await Promise.resolve();

		expect(hoisted.audio.play).toHaveBeenCalledTimes(1);
	});

	it('seekTo updates currentTime when stream is seekable', () => {
		const source = new NativeAudioSource('local', { url: '/seek.mp3', seekable: true });

		source.seekTo(42);

		expect(hoisted.audio.currentTime).toBe(42);
	});

	it('seekTo is no-op when stream is not seekable', () => {
		const source = new NativeAudioSource('jellyfin', { url: '/transcode.opus', seekable: false });
		hoisted.audio.currentTime = 5;

		source.seekTo(60);

		expect(hoisted.audio.currentTime).toBe(5);
	});

	it('destroy clears src and stops delivering events', async () => {
		const source = new NativeAudioSource('local', { url: '/destroy.mp3', seekable: true });
		const loadPromise = source.load();
		hoisted.dispatch('canplay');
		await loadPromise;

		const onState = vi.fn();
		source.onStateChange(onState);
		source.destroy();

		expect(hoisted.audio.src).toBe('');
		// Detached listeners must no longer reach this instance.
		hoisted.dispatch('play');
		hoisted.dispatch('timeupdate');
		expect(onState).not.toHaveBeenCalled();
	});

	it('throws when audio element is unavailable', () => {
		hoisted.getAudioElement.mockImplementationOnce(() => {
			throw new Error('Audio element not mounted');
		});

		expect(() => new NativeAudioSource('local', { url: '/missing.mp3', seekable: true })).toThrow(
			'Audio element not mounted'
		);
	});

	it('fires onProgress callback on timeupdate events', async () => {
		const source = new NativeAudioSource('local', { url: '/progress.mp3', seekable: true });
		const onProgress = vi.fn();
		source.onProgress(onProgress);

		const loadPromise = source.load();
		hoisted.dispatch('canplay');
		await loadPromise;

		hoisted.audio.currentTime = 42;
		hoisted.audio.duration = 180;
		hoisted.dispatch('timeupdate');

		expect(onProgress).toHaveBeenCalledWith(42, 180);
	});

	it('rejects load promise on media error event', async () => {
		const source = new NativeAudioSource('local', { url: '/bad.mp3', seekable: true });
		const onError = vi.fn();
		source.onError(onError);

		const loadPromise = source.load();

		hoisted.audio.error = { code: 4 } as MediaError;
		hoisted.dispatch('error');

		await expect(loadPromise).rejects.toThrow('MEDIA_ERR_SRC_NOT_SUPPORTED');
		expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'LOAD_ERROR' }));
	});

	it('transitions from buffering back to playing after seek via playing event', async () => {
		const source = new NativeAudioSource('local', { url: '/seek.mp3', seekable: true });
		const states: string[] = [];
		source.onStateChange((s) => states.push(s));

		const loadPromise = source.load();
		hoisted.dispatch('canplay');
		await loadPromise;

		hoisted.dispatch('play');
		expect(states).toContain('playing');

		hoisted.dispatch('waiting');
		expect(states.at(-1)).toBe('buffering');

		hoisted.dispatch('playing');
		expect(states.at(-1)).toBe('playing');
	});

	it('transitions from buffering back to playing via timeupdate fallback', async () => {
		const source = new NativeAudioSource('local', { url: '/seek2.mp3', seekable: true });
		const states: string[] = [];
		source.onStateChange((s) => states.push(s));

		const loadPromise = source.load();
		hoisted.dispatch('canplay');
		await loadPromise;

		hoisted.dispatch('play');
		hoisted.dispatch('waiting');
		expect(states.at(-1)).toBe('buffering');

		hoisted.audio.currentTime = 30;
		hoisted.dispatch('timeupdate');
		expect(states.at(-1)).toBe('playing');
	});

	it('does not emit redundant playing state on timeupdate when already playing', async () => {
		const source = new NativeAudioSource('local', { url: '/no-dup.mp3', seekable: true });
		const states: string[] = [];
		source.onStateChange((s) => states.push(s));

		const loadPromise = source.load();
		hoisted.dispatch('canplay');
		await loadPromise;

		hoisted.dispatch('play');
		const countAfterPlay = states.filter((s) => s === 'playing').length;

		hoisted.audio.currentTime = 10;
		hoisted.dispatch('timeupdate');

		expect(states.filter((s) => s === 'playing').length).toBe(countAfterPlay);
	});
	it('a superseded source does not clear the element the new source loaded into', async () => {
		const first = new NativeAudioSource('local', { url: '/first.mp3', seekable: true });
		const firstLoad = first.load();
		hoisted.dispatch('canplay');
		await firstLoad;

		const second = new NativeAudioSource('local', { url: '/second.mp3', seekable: true });
		const secondLoad = second.load();
		hoisted.dispatch('canplay');
		await secondLoad;

		// The store can destroy the previous source after the new one loaded.
		// Doing so must not stop the track that is now playing.
		first.destroy();

		expect(hoisted.audio.src).toBe('/second.mp3');
		expect(hoisted.audio.pause).not.toHaveBeenCalled();
	});

	it('stops the element when a load times out', async () => {
		vi.useFakeTimers();
		try {
			const source = new NativeAudioSource('local', { url: '/slow.mp3', seekable: true });
			const loadPromise = source.load();
			const assertion = expect(loadPromise).rejects.toThrow('timed out');
			await vi.advanceTimersByTimeAsync(15_000);
			await assertion;

			// A element still trying to load keeps the request alive.
			expect(hoisted.audio.pause).toHaveBeenCalled();
			expect(hoisted.audio.src).toBe('');
		} finally {
			vi.useRealTimers();
		}
	});

	it('stops the element when playback stalls', async () => {
		vi.useFakeTimers();
		try {
			const source = new NativeAudioSource('local', { url: '/stall.mp3', seekable: true });
			const loadPromise = source.load();
			hoisted.dispatch('canplay');
			await loadPromise;

			hoisted.dispatch('waiting');
			await vi.advanceTimersByTimeAsync(15_000);

			expect(hoisted.audio.pause).toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not emit a state it is already in', async () => {
		const source = new NativeAudioSource('local', { url: '/dedupe.mp3', seekable: true });
		const states: string[] = [];
		source.onStateChange((state) => states.push(state));
		const loadPromise = source.load();
		hoisted.dispatch('canplay');
		await loadPromise;

		hoisted.dispatch('play');
		hoisted.dispatch('playing');
		hoisted.dispatch('play');

		expect(states.filter((state) => state === 'playing')).toHaveLength(1);
	});

	it('ignores seekTo after destroy', async () => {
		const source = new NativeAudioSource('local', { url: '/seek.mp3', seekable: true });
		const loadPromise = source.load();
		hoisted.dispatch('canplay');
		await loadPromise;
		source.destroy();

		hoisted.audio.currentTime = 5;
		source.seekTo(120);

		expect(hoisted.audio.currentTime).toBe(5);
	});
	it('suspends the audio graph on pause and on destroy', async () => {
		const source = new NativeAudioSource('local', { url: '/suspend.mp3', seekable: true });
		const loadPromise = source.load();
		hoisted.dispatch('canplay');
		await loadPromise;

		source.pause();
		expect(hoisted.suspendAudioEngine).toHaveBeenCalledTimes(1);

		source.destroy();
		expect(hoisted.suspendAudioEngine).toHaveBeenCalledTimes(2);
	});

	it('does not suspend the graph when a superseded source is destroyed', async () => {
		const first = new NativeAudioSource('local', { url: '/a.mp3', seekable: true });
		const firstLoad = first.load();
		hoisted.dispatch('canplay');
		await firstLoad;

		const second = new NativeAudioSource('local', { url: '/b.mp3', seekable: true });
		const secondLoad = second.load();
		hoisted.dispatch('canplay');
		await secondLoad;

		hoisted.suspendAudioEngine.mockClear();
		first.destroy();

		// The graph belongs to the track that is still playing.
		expect(hoisted.suspendAudioEngine).not.toHaveBeenCalled();
	});
});
