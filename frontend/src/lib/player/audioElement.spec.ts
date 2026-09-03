import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockEngine = vi.hoisted(() => ({
	connect: vi.fn(),
	destroy: vi.fn(),
	isConnected: vi.fn(() => true),
	resume: vi.fn(async () => undefined)
}));

vi.mock('./audioEngine', () => {
	const MockAudioEngine = vi.fn().mockImplementation(() => mockEngine);
	return { AudioEngine: MockAudioEngine };
});

import {
	_resetAudioElement,
	getAudioElement,
	getAudioEngine,
	resumeAudioEngine,
	tryGetAudioEngine,
	setAudioElement,
	usesNativeBackgroundPlayback
} from './audioElement';

describe('audioElement registry', () => {
	beforeEach(() => {
		_resetAudioElement();
		vi.clearAllMocks();
		mockEngine.resume.mockResolvedValue(undefined);
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

	it('keeps installed iOS PWA playback on the native audio element', () => {
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

	it('keeps Android playback on the native audio element', () => {
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
	});
});
