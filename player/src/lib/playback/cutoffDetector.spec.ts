import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CutoffDetector, findCutoff, FULL_RANGE_HZ } from './cutoffDetector';

const SAMPLE_RATE = 48_000;
const BIN_HZ = SAMPLE_RATE / 2048;

/** Music at -40 dB up to `cutoffHz`, the encoder's noise floor (-130 dB) above. */
function spectrum(cutoffHz: number): Float32Array {
	const bins = new Float32Array(1024);
	for (let k = 0; k < bins.length; k++) bins[k] = k * BIN_HZ < cutoffHz ? -40 - (k * BIN_HZ) / 1000 : -130;
	return bins;
}

describe('findCutoff', () => {
	it('finds the brick wall of a 128 kbps MP3 (~16 kHz)', () => {
		const hz = findCutoff(spectrum(16_000), BIN_HZ)!;
		expect(hz).toBeGreaterThan(15_800);
		expect(hz).toBeLessThan(16_200);
	});

	it('reports full-range audio at the top of the spectrum', () => {
		expect(findCutoff(spectrum(24_000), BIN_HZ)!).toBeGreaterThanOrEqual(FULL_RANGE_HZ);
	});

	it('gives up on silence', () => {
		expect(findCutoff(new Float32Array(1024).fill(-140), BIN_HZ)).toBeNull();
	});
});

describe('CutoffDetector', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	function setup(cutoffHz: number) {
		const analyser = {
			fftSize: 0,
			smoothingTimeConstant: 1,
			minDecibels: -100,
			frequencyBinCount: 1024,
			getFloatFrequencyData: (out: Float32Array) => out.set(spectrum(cutoffHz))
		};
		const ctx = { state: 'running', sampleRate: SAMPLE_RATE, createAnalyser: () => analyser };
		const tap = { connect: vi.fn(), disconnect: vi.fn() };
		const found = vi.fn();
		const detector = new CutoffDetector(ctx as never, tap as never, found);
		return { detector, tap, found };
	}

	it('measures for a few seconds, reports, and takes the analyser off the graph', () => {
		const { detector, tap, found } = setup(16_000);
		detector.start();
		expect(tap.connect).not.toHaveBeenCalled(); // nothing until the first read
		vi.advanceTimersByTime(10_000);
		expect(found).toHaveBeenCalledTimes(1);
		expect(found.mock.calls[0][0]).toBeCloseTo(16_000, -3);
		expect(tap.connect).toHaveBeenCalledTimes(1);
		expect(tap.disconnect).toHaveBeenCalledTimes(1);
	});

	it('a track change cancels the measurement in progress', () => {
		const { detector, found } = setup(16_000);
		detector.start();
		vi.advanceTimersByTime(2_000);
		detector.stop();
		vi.advanceTimersByTime(10_000);
		expect(found).not.toHaveBeenCalled();
	});

	it('does not read while the page is hidden', () => {
		const { detector, tap, found } = setup(16_000);
		const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
		detector.start();
		vi.advanceTimersByTime(20_000);
		expect(tap.connect).not.toHaveBeenCalled();
		expect(found).not.toHaveBeenCalled();
		hidden.mockRestore();
	});
});

describe('isLossless / enhancerMode', () => {
	it('tells lossless files by format, ALAC by bitrate', async () => {
		const { isLossless } = await import('./cutoffDetector');
		expect(isLossless({ suffix: 'flac' })).toBe(true);
		expect(isLossless({ suffix: 'm4a', bitRate: 900 })).toBe(true); // ALAC
		expect(isLossless({ suffix: 'm4a', bitRate: 256 })).toBe(false); // AAC
		expect(isLossless({ suffix: 'opus' })).toBe(false);
		expect(isLossless({ suffix: 'm4a', contentType: 'audio/mp4' })).toBe(false); // yt-
	});

	it('never calls a full-band lossy stream (YouTube Opus) lossless', async () => {
		const { enhancerMode } = await import('./cutoffDetector');
		expect(enhancerMode({ lossless: false, cutoff: 20_000 })).toBe('detail');
		expect(enhancerMode({ lossless: false, cutoff: 16_000 })).toBe('restore');
		expect(enhancerMode({ lossless: false, cutoff: null })).toBe('unknown');
		expect(enhancerMode({ lossless: true, cutoff: null })).toBe('lossless');
	});
});
