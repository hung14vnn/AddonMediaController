import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockEngine = vi.hoisted(() => ({
	connect: vi.fn(),
	destroy: vi.fn(),
	isConnected: vi.fn(() => true),
	resume: vi.fn(async () => undefined),
	suspend: vi.fn(async () => undefined)
}));

vi.mock('./audioEngine', () => {
	const MockAudioEngine = vi.fn().mockImplementation(function () { return mockEngine; });
	return { AudioEngine: MockAudioEngine };
});

import {
	_resetAudioElement,
	getAudioElement,
	getAudioEngine,
	resumeAudioEngine,
	suspendAudioEngine,
	tryGetAudioEngine,
	setAudioElement,
	usesNativeBackgroundPlayback
} from './audioElement';

describe('audioElement registry', () => {
	beforeEach(() => {
		_resetAudioElement();
		vi.clearAllMocks();
		mockEngine.resume.mockResolvedValue(undefined);
		mockEngine.suspend.mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('throws when getting audio element before registration', () => {
		expect.assertions(1);
		expect(() => getAudioElement()).toThrow('Audio element not mounted');
	});

	it('returns registered audio element', () => {
		expect.assertions(1);
		const audio = { src: '' } as HTMLAudioElement;
		setAudioElement(audio);
		expect(getAudioElement()).toBe(audio);
	});

	it('allows replacing the registered audio element', () => {
		expect.assertions(1);
		const first = { src: '' } as HTMLAudioElement;
		const second = { src: '' } as HTMLAudioElement;
		setAudioElement(first);
		setAudioElement(second);
		expect(getAudioElement()).toBe(second);
	});

	it('is idempotent for the same element', () => {
		expect.assertions(1);
		const audio = { src: '' } as HTMLAudioElement;
		setAudioElement(audio);
		const engineFirst = tryGetAudioEngine();
		setAudioElement(audio);
		const engineSecond = tryGetAudioEngine();
		expect(engineFirst).toBe(engineSecond);
	});

	it('throws getAudioEngine before registration', () => {
		expect.assertions(1);
		expect(() => getAudioEngine()).toThrow('Audio engine not initialized');
	});

	it('returns engine after setAudioElement', () => {
		expect.assertions(2);
		const audio = { src: '' } as HTMLAudioElement;
		setAudioElement(audio);
		const engine = getAudioEngine();
		expect(engine).toBeDefined();
		expect(engine.connect).toBeDefined();
	});

	it('tryGetAudioEngine returns null before registration', () => {
		expect.assertions(1);
		expect(tryGetAudioEngine()).toBeNull();
	});

	it('defers creating the engine after registration', () => {
		expect.assertions(1);
		const audio = { src: '' } as HTMLAudioElement;
		setAudioElement(audio);
		expect(tryGetAudioEngine()).toBeNull();
	});

	it('_resetAudioElement destroys engine', () => {
		expect.assertions(2);
		const audio = { src: '' } as HTMLAudioElement;
		setAudioElement(audio);
		const engine = getAudioEngine();
		_resetAudioElement();
		expect(engine.destroy).toHaveBeenCalled();
		expect(tryGetAudioEngine()).toBeNull();
	});

	it('resumeAudioEngine calls the registered engine', async () => {
		expect.assertions(1);
		const audio = { src: '' } as HTMLAudioElement;
		setAudioElement(audio);

		await resumeAudioEngine();

		expect(mockEngine.resume).toHaveBeenCalledTimes(1);
	});

	it('resumeAudioEngine is a no-op when the engine is unavailable', async () => {
		expect.assertions(1);

		await resumeAudioEngine();

		expect(mockEngine.resume).not.toHaveBeenCalled();
	});

	it('resumeAudioEngine swallows browser resume rejections', async () => {
		expect.assertions(2);
		const audio = { src: '' } as HTMLAudioElement;
		setAudioElement(audio);
		mockEngine.resume.mockRejectedValueOnce(new Error('not allowed'));

		await expect(resumeAudioEngine()).resolves.toBeUndefined();
		expect(mockEngine.resume).toHaveBeenCalledTimes(1);
	});

	it('allows the audio engine on iOS while keeping native background detection', () => {
		vi.stubGlobal('navigator', {
			userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
			platform: 'iPhone',
			maxTouchPoints: 5,
			standalone: true
		});
		const audio = { src: '' } as HTMLAudioElement;

		setAudioElement(audio);

		expect(usesNativeBackgroundPlayback()).toBe(true);
		expect(getAudioElement()).toBe(audio);
		expect(tryGetAudioEngine()).toBeNull();
		expect(mockEngine.connect).not.toHaveBeenCalled();
		getAudioEngine();
		expect(mockEngine.connect).toHaveBeenCalledWith(audio);
	});

	it('does not create the engine from the playback path on iOS', async () => {
		// Regression: the play path must leave iOS on the native media element.
		// Creating a context here put every track on a real-time render thread.
		vi.stubGlobal('navigator', {
			userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
			platform: 'iPhone',
			maxTouchPoints: 5
		});
		const audio = { src: '' } as HTMLAudioElement;
		setAudioElement(audio);

		await resumeAudioEngine();

		expect(tryGetAudioEngine()).toBeNull();
		expect(mockEngine.connect).not.toHaveBeenCalled();
		expect(mockEngine.resume).not.toHaveBeenCalled();
	});

	it('still resumes an EQ-created engine from the playback path on iOS', async () => {
		vi.stubGlobal('navigator', {
			userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
			platform: 'iPhone',
			maxTouchPoints: 5
		});
		const audio = { src: '' } as HTMLAudioElement;
		setAudioElement(audio);
		getAudioEngine(); // the EQ store opting in

		await resumeAudioEngine();

		expect(mockEngine.connect).toHaveBeenCalledTimes(1);
		expect(mockEngine.resume).toHaveBeenCalledTimes(1);
	});

	it('creates the engine from the playback path off iOS', async () => {
		vi.stubGlobal('navigator', {
			userAgent: 'Mozilla/5.0 (Linux; Android 15)',
			platform: 'Linux armv8l',
			maxTouchPoints: 5
		});
		const audio = { src: '' } as HTMLAudioElement;
		setAudioElement(audio);

		await resumeAudioEngine();

		expect(mockEngine.connect).toHaveBeenCalledWith(audio);
		expect(mockEngine.resume).toHaveBeenCalledTimes(1);
	});

	it('keeps iPhone playback native even when standalone detection is unavailable', () => {
		vi.stubGlobal('navigator', {
			userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
			platform: 'iPhone',
			maxTouchPoints: 5
		});

		expect(usesNativeBackgroundPlayback()).toBe(true);
	});

	it('recognizes an installed iPad PWA using a desktop user agent', () => {
		vi.stubGlobal('navigator', {
			userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)',
			platform: 'MacIntel',
			maxTouchPoints: 5
		});
		vi.stubGlobal('window', {
			matchMedia: vi.fn(() => ({ matches: true }))
		});

		expect(usesNativeBackgroundPlayback()).toBe(true);
	});

	it('allows the audio engine on Android', () => {
		vi.stubGlobal('navigator', {
			userAgent: 'Mozilla/5.0 (Linux; Android 15)',
			platform: 'Linux armv8l',
			maxTouchPoints: 5
		});
		const audio = { src: '' } as HTMLAudioElement;

		setAudioElement(audio);

		expect(usesNativeBackgroundPlayback()).toBe(false);
		expect(tryGetAudioEngine()).toBeNull();
		expect(mockEngine.connect).not.toHaveBeenCalled();
		getAudioEngine();
		expect(mockEngine.connect).toHaveBeenCalledWith(audio);
	});
	it('suspends the engine when one exists', async () => {
		const audio = { src: '' } as HTMLAudioElement;
		setAudioElement(audio);
		getAudioEngine();

		await suspendAudioEngine();

		expect(mockEngine.suspend).toHaveBeenCalled();
	});

	it('suspending without an engine is a no-op', async () => {
		await expect(suspendAudioEngine()).resolves.toBeUndefined();
		expect(mockEngine.suspend).not.toHaveBeenCalled();
	});

	it('swallows a rejected suspend', async () => {
		const audio = { src: '' } as HTMLAudioElement;
		setAudioElement(audio);
		getAudioEngine();
		mockEngine.suspend.mockRejectedValueOnce(new Error('nope'));

		await expect(suspendAudioEngine()).resolves.toBeUndefined();
	});
});
