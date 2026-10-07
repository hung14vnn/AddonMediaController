// Finds where a file's treble stops. Lossy encoders drop everything above a fixed
// frequency (about 16 kHz for 128 kbps MP3, 15–20 kHz for YouTube's AAC/Opus): a
// "brick wall" in the spectrum. The Sound Enhancer works right below it.

/**
 * At or above this the spectrum reaches the top. That alone doesn't mean "nothing
 * lost": Opus (YouTube's stream off iOS) fills its top bands with shaped noise, so
 * only a lossless file there has nothing to restore (see isLossless).
 */
export const FULL_RANGE_HZ = 19_500;

const LOSSLESS_SUFFIXES = new Set(['flac', 'wav', 'wave', 'aif', 'aiff', 'alac', 'ape', 'wv', 'dsf', 'dff']);
/** ALAC usually arrives as .m4a like AAC; its bitrate gives it away. */
const LOSSLESS_MIN_KBPS = 600;

/** Whether a track is stored losslessly, from what the server says about its file. */
export function isLossless(track: { suffix?: string; contentType?: string; bitRate?: number }): boolean {
	const suffix = track.suffix?.toLowerCase() ?? '';
	if (LOSSLESS_SUFFIXES.has(suffix)) return true;
	const type = track.contentType?.toLowerCase() ?? '';
	if (/flac|wav|aiff|alac/.test(type)) return true;
	return suffix === 'm4a' && (track.bitRate ?? 0) >= LOSSLESS_MIN_KBPS;
}

/** What the Sound Enhancer knows about the playing track. */
export interface EnhancerSource {
	lossless: boolean;
	/** Measured treble cutoff in Hz; null until measured. */
	cutoff: number | null;
}

/**
 * - `lossless`: nothing was thrown away; leave it alone.
 * - `restore`: a lossy file with its top cut off; rebuild above the cutoff.
 * - `detail`: a lossy file whose spectrum still reaches the top (Opus, MP3 320):
 *   nothing to rebuild, but its coarse highs gain from gentle extra detail.
 * - `unknown`: lossy, not measured yet; a broad, gentle brightening.
 */
export type EnhancerMode = 'lossless' | 'restore' | 'detail' | 'unknown';

export function enhancerMode(source: EnhancerSource): EnhancerMode {
	if (source.lossless) return 'lossless';
	if (source.cutoff === null) return 'unknown';
	return source.cutoff >= FULL_RANGE_HZ ? 'detail' : 'restore';
}

const FFT_SIZE = 2048;
const DELAY_MS = 1500; // past the first moments, often quiet or a fade-in
const EVERY_MS = 200;
const FRAMES = 15; // ~3 s of music
/** Give up after this many reads without enough music (paused, hidden, silent). */
const MAX_TRIES = 40;
/** A bin counts as content within this many dB of the track's 1–8 kHz level. */
const CONTENT_RANGE_DB = 60;
/** Quieter than this the frame is silence and would only lower the peaks. */
const SILENCE_DB = -100;

/**
 * The highest frequency in a spectrum (dB per bin, averaged over a few seconds)
 * that is still within CONTENT_RANGE_DB of the 1–8 kHz median; null when it is
 * all silence.
 */
export function findCutoff(peakDb: Float32Array, binHz: number): number | null {
	const from = Math.floor(1000 / binHz);
	const to = Math.min(peakDb.length, Math.ceil(8000 / binHz));
	const mid = Array.from(peakDb.subarray(from, to)).sort((a, b) => a - b);
	const reference = mid[Math.floor(mid.length / 2)];
	if (!Number.isFinite(reference) || reference < SILENCE_DB) return null;
	for (let k = peakDb.length - 1; k >= to; k--) {
		if (peakDb[k] > reference - CONTENT_RANGE_DB) return (k + 1) * binHz;
	}
	return to * binHz;
}

/**
 * Taps `tap` with an AnalyserNode for a few seconds at the start of a track and
 * reports the cutoff. The analyser is connected only while measuring: it runs an
 * FFT over every rendered block once connected. Reads only while the page is
 * visible, since background timers are throttled; a track measured in the
 * background keeps the previous track's cutoff.
 */
export class CutoffDetector {
	private analyser: AnalyserNode | null = null;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private generation = 0;

	constructor(
		private readonly ctx: BaseAudioContext,
		private readonly tap: AudioNode,
		private readonly found: (hz: number) => void
	) {}

	start() {
		this.stop();
		const generation = this.generation;
		// Mean power per bin, not the peak: a few transients or encoder glitches
		// above the cutoff would otherwise read as treble the file doesn't have.
		const power = new Float64Array(FFT_SIZE / 2);
		let frames = 0;
		let tries = 0;
		const frame = () => {
			if (generation !== this.generation) return;
			if (++tries > MAX_TRIES) return this.stop();
			if (!document.hidden && this.ctx.state === 'running') {
				const analyser = this.connect();
				const bins = new Float32Array(analyser.frequencyBinCount);
				analyser.getFloatFrequencyData(bins);
				let loudest = -Infinity;
				for (const v of bins) if (v > loudest) loudest = v;
				if (loudest > SILENCE_DB) {
					for (let k = 0; k < bins.length; k++) power[k] += 10 ** (bins[k] / 10);
					frames++;
				}
			}
			if (frames >= FRAMES) {
				const meanDb = new Float32Array(power.length);
				for (let k = 0; k < power.length; k++) meanDb[k] = 10 * Math.log10(power[k] / frames || 1e-14);
				const hz = findCutoff(meanDb, this.ctx.sampleRate / FFT_SIZE);
				this.stop();
				if (hz !== null) this.found(hz);
				return;
			}
			this.timer = setTimeout(frame, EVERY_MS);
		};
		this.timer = setTimeout(frame, DELAY_MS);
	}

	/** Cancels a measurement and takes the analyser off the graph. */
	stop() {
		this.generation++;
		clearTimeout(this.timer);
		if (this.analyser) {
			this.tap.disconnect(this.analyser);
			this.analyser = null;
		}
	}

	private connect(): AnalyserNode {
		if (!this.analyser) {
			this.analyser = this.ctx.createAnalyser();
			this.analyser.fftSize = FFT_SIZE;
			this.analyser.smoothingTimeConstant = 0;
			this.analyser.minDecibels = -140;
			this.tap.connect(this.analyser);
		}
		return this.analyser;
	}
}
