// Web Audio output for the player (Settings › Playback › Web Audio). Every audio
// element the player creates is fed into one graph:
//
//   element → MediaElementSource → trim → fade ─┐
//   element → MediaElementSource → trim → fade ─┴→ bus → [preamp → 10 EQ bands] → eqOut
//        eqOut → [Sound Enhancer] → volume → speakers
//
// Optional stages are spliced in only while they are on, so the default path is
// bus → eqOut → volume: biquads and shapers cost battery even when they do nothing.
// Volume is a GainNode, which iOS honours (it ignores `audio.volume`). Per element,
// `trim` holds the track's ReplayGain and `fade` the crossfade, so the two never
// fight over one parameter's automation. While the
// enhancer is on, an analyser briefly taps the bus at the start of each track to
// find where its treble was cut off (see cutoffDetector.ts).
// Kept apart from the player so the plain <audio> engine never touches any of this.
import { audioSettings } from './audioSettings.svelte';
import { CutoffDetector, enhancerMode, type EnhancerSource } from './cutoffDetector';
import { logPlayback } from './debugLog';
import { EQ_BAND_COUNT, EQ_FREQUENCIES } from './eqPresets';

const EQ_Q = 1.4;
/** Seconds for volume, EQ and enhancer moves to settle: quick, without zipper noise. */
const RAMP_S = 0.03;
/**
 * Paused this long, the context is suspended. A running context renders silence
 * nonstop, keeping the audio hardware open and the CPU out of deep sleep.
 */
const IDLE_SUSPEND_MS = 10_000;

type AudioContextCtor = typeof AudioContext;

/**
 * Drops `param`'s automation from `now` on, keeping its current value. Also ends a
 * value curve still running, which cancelScheduledValues alone leaves in place in
 * some browsers (and a new curve overlapping it throws).
 */
function hold(param: AudioParam, now: number) {
	if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(now);
	else param.cancelScheduledValues(now);
}

/**
 * Soft saturation with a little asymmetry: odd and even harmonics, like the
 * exciters behind iTunes' Sound Enhancer. Fed only highs, it adds "air" above them.
 */
function exciterCurve(samples = 2048): Float32Array<ArrayBuffer> {
	const curve = new Float32Array(samples);
	for (let i = 0; i < samples; i++) {
		const x = (i / (samples - 1)) * 2 - 1;
		curve[i] = Math.tanh(2.5 * x) + 0.25 * x * x;
	}
	return curve;
}

/** Exciter bands (highpass before / after the shaper) and strength, per mode. */
function enhancerBands(source: EnhancerSource): { source: number; keep: number; amount: number } {
	switch (enhancerMode(source)) {
		case 'lossless':
			return { source: 3000, keep: 5000, amount: 0 };
		case 'restore': {
			// The 2nd and 3rd harmonics of the source band reach past the cutoff.
			const cutoff = source.cutoff!;
			return {
				source: Math.max(2500, Math.min(8000, cutoff / 2.5)),
				keep: Math.max(4000, cutoff * 0.9),
				amount: 1
			};
		}
		case 'detail':
			// Air over the coarse, noise-filled top octave.
			return { source: 5000, keep: 10_000, amount: 0.7 };
		default:
			return { source: 3000, keep: 5000, amount: 1 };
	}
}

/**
 * Sound Enhancer (an exciter): the signal plus generated harmonics of its highs,
 * slightly widened. Compressed audio loses its top end; this brings back
 * brightness and space (synthesised, not the lost detail itself). Given the
 * track's cutoff it works right below it, so the new harmonics land where the
 * encoder removed the original ones; lossless audio is left alone.
 *
 *   in ─→ L/R widening matrix ────────────────────────────────────┐
 *   in ─→ highpass (source) → shaper → highpass (keep) → wet gain ┴→ out
 */
class SoundEnhancer {
	readonly input: GainNode;
	readonly output: GainNode;
	private readonly wet: GainNode;
	private readonly lowCut: BiquadFilterNode;
	private readonly highPass: BiquadFilterNode;
	private level = 0.5;
	private source: EnhancerSource = { lossless: false, cutoff: null };
	/** [L→L, R→L, R→R, L→R] gains of the widening matrix. */
	private readonly matrix: GainNode[];

	constructor(private readonly ctx: AudioContext) {
		this.input = ctx.createGain();
		// Up-mix mono to stereo here: the splitter would leave a mono source's right
		// channel silent and the matrix would turn that into a one-sided image.
		this.input.channelCount = 2;
		this.input.channelCountMode = 'explicit';
		this.input.channelInterpretation = 'speakers';
		this.output = ctx.createGain();

		const split = ctx.createChannelSplitter(2);
		const merge = ctx.createChannelMerger(2);
		this.matrix = [0, 1, 2, 3].map(() => ctx.createGain());
		const [ll, rl, rr, lr] = this.matrix;
		this.input.connect(split);
		split.connect(ll, 0).connect(merge, 0, 0);
		split.connect(rl, 1).connect(merge, 0, 0);
		split.connect(rr, 1).connect(merge, 0, 1);
		split.connect(lr, 0).connect(merge, 0, 1);
		merge.connect(this.output);

		this.lowCut = ctx.createBiquadFilter();
		this.lowCut.type = 'highpass';
		const shaper = ctx.createWaveShaper();
		shaper.curve = exciterCurve();
		// 2x: the harmonics are quiet and high, so 4x's extra anti-aliasing isn't
		// audible, and 2x halves the shaper's cost.
		shaper.oversample = '2x';
		// Keeps only what the shaper made above the band (and drops its DC offset).
		this.highPass = ctx.createBiquadFilter();
		this.highPass.type = 'highpass';
		this.wet = ctx.createGain();
		this.input
			.connect(this.lowCut)
			.connect(shaper)
			.connect(this.highPass)
			.connect(this.wet)
			.connect(this.output);
		this.update();
	}

	/** 0 (low) … 1 (high). */
	setLevel(level: number) {
		this.level = level;
		this.update();
	}

	setSource(source: EnhancerSource) {
		this.source = source;
		this.update();
	}

	private update() {
		const now = this.ctx.currentTime;
		const level = this.level;
		const bands = enhancerBands(this.source);
		this.lowCut.frequency.setTargetAtTime(bands.source, now, RAMP_S);
		this.highPass.frequency.setTargetAtTime(bands.keep, now, RAMP_S);
		// Lossless audio is missing nothing: no harmonics, no widening.
		const amount = bands.amount;
		this.wet.gain.setTargetAtTime((0.15 + 0.45 * level) * amount, now, RAMP_S);
		// Mid/side widening: L' = L + w(L − R), R' = R + w(R − L).
		const width = (0.05 + 0.2 * level) * amount;
		const [ll, rl, rr, lr] = this.matrix;
		ll.gain.setTargetAtTime(1 + width, now, RAMP_S);
		rr.gain.setTargetAtTime(1 + width, now, RAMP_S);
		rl.gain.setTargetAtTime(-width, now, RAMP_S);
		lr.gain.setTargetAtTime(-width, now, RAMP_S);
		// The added harmonics and width make it louder; keep the level the same.
		this.output.gain.setTargetAtTime(1 / (1 + 0.35 * level * amount), now, RAMP_S);
	}
}

export class WebAudioOutput {
	private readonly ctx: AudioContext;
	private readonly bus: GainNode;
	private readonly preamp: GainNode;
	private readonly filters: BiquadFilterNode[];
	private readonly eqOut: GainNode;
	private readonly enhancer: SoundEnhancer;
	private readonly detector: CutoffDetector;
	private source: EnhancerSource = { lossless: false, cutoff: null };
	private lossless = false;
	private lastLossyCutoff: number | null = null;
	private readonly volume: GainNode;
	private readonly channels = new WeakMap<HTMLMediaElement, { trim: GainNode; fade: GainNode }>();
	/** Whether the bus feeds the EQ / eqOut feeds the enhancer; null until first routed. */
	private eqRouted: boolean | null = null;
	private enhancerRouted: boolean | null = null;
	private readonly stopSettings: () => void;
	private readonly unlockEvents = ['pointerdown', 'touchend', 'keydown'] as const;
	private readonly elements = new Set<HTMLMediaElement>();
	private idleTimer: ReturnType<typeof setTimeout> | undefined;

	/**
	 * `wantsSound()`: the player means to be playing, so a suspended context is resumed.
	 * `onSource`: what the Sound Enhancer knows about the playing track, as it learns it.
	 */
	constructor(
		private readonly wantsSound: () => boolean,
		private readonly onSource: (source: EnhancerSource) => void = () => {}
	) {
		const Ctor: AudioContextCtor =
			window.AudioContext ?? (window as unknown as { webkitAudioContext: AudioContextCtor }).webkitAudioContext;
		this.ctx = new Ctor({ latencyHint: 'playback' });
		this.bus = this.ctx.createGain();
		this.preamp = this.ctx.createGain();
		this.eqOut = this.ctx.createGain();
		this.volume = this.ctx.createGain();
		this.filters = EQ_FREQUENCIES.map((frequency) => {
			const f = this.ctx.createBiquadFilter();
			f.type = 'peaking';
			f.frequency.value = frequency;
			f.Q.value = EQ_Q;
			return f;
		});
		let prev: AudioNode = this.preamp;
		for (const f of this.filters) {
			prev.connect(f);
			prev = f;
		}
		prev.connect(this.eqOut);
		this.enhancer = new SoundEnhancer(this.ctx);
		this.enhancer.output.connect(this.volume);
		this.volume.connect(this.ctx.destination);
		// Measured on the bus: the file as decoded, before the EQ colours it.
		this.detector = new CutoffDetector(this.ctx, this.bus, (hz) => {
			this.setSource({ lossless: false, cutoff: hz });
			logPlayback('enhancer-cutoff', `${Math.round(hz)} Hz → ${enhancerMode(this.source)}`);
		});

		this.applySettings();
		this.stopSettings = audioSettings.onChange(() => this.applySettings());
		this.ctx.addEventListener('statechange', this.onStateChange);
		// A context starts suspended until a user gesture resumes it (the same unlock
		// howler.js does). Any tap on the page counts, not just the play button.
		for (const type of this.unlockEvents) document.addEventListener(type, this.unlock, true);
	}

	/** Route an element's sound through the graph. An element can only ever join one. */
	attach(el: HTMLMediaElement) {
		if (this.channels.has(el)) return;
		const trim = this.ctx.createGain();
		const fade = this.ctx.createGain();
		this.ctx.createMediaElementSource(el).connect(trim).connect(fade).connect(this.bus);
		this.channels.set(el, { trim, fade });
		this.elements.add(el);
		el.addEventListener('play', this.onElementPlay);
		for (const type of ['pause', 'ended', 'emptied']) el.addEventListener(type, this.onElementIdle);
	}

	/** ReplayGain for what `el` plays (linear); `smooth` for a change mid-song. */
	setTrim(el: HTMLMediaElement, gain: number, smooth = false) {
		const param = this.channels.get(el)?.trim.gain;
		if (!param) return;
		const now = this.ctx.currentTime;
		hold(param, now);
		if (smooth) param.setTargetAtTime(gain, now, RAMP_S * 5);
		else param.setValueAtTime(gain, now);
	}

	/**
	 * Fades `from` out and `to` in over `seconds`, equal power (cos/sin), so the
	 * overlap doesn't dip in loudness the way two straight ramps would.
	 */
	crossfade(from: HTMLMediaElement, to: HTMLMediaElement, seconds: number) {
		const out = this.channels.get(from)?.fade.gain;
		const inn = this.channels.get(to)?.fade.gain;
		if (!out || !inn) return;
		const now = this.ctx.currentTime;
		const steps = 64;
		const fadeOut = new Float32Array(steps);
		const fadeIn = new Float32Array(steps);
		for (let i = 0; i < steps; i++) {
			const t = (i / (steps - 1)) * (Math.PI / 2);
			fadeOut[i] = Math.cos(t);
			fadeIn[i] = Math.sin(t);
		}
		// Start where the outgoing fade is now (it may have been mid-ramp).
		fadeOut.forEach((v, i) => (fadeOut[i] = v * out.value));
		for (const param of [out, inn]) hold(param, now);
		try {
			out.setValueCurveAtTime(fadeOut, now, seconds);
			inn.setValueCurveAtTime(fadeIn, now, seconds);
		} catch (e) {
			logPlayback('crossfade-failed', String(e));
			for (const param of [out, inn]) hold(param, now);
			out.setValueAtTime(0, now);
			inn.setValueAtTime(1, now);
		}
	}

	/** `el` at full level right away: a track started without a crossfade. */
	resetFade(el: HTMLMediaElement) {
		const param = this.channels.get(el)?.fade.gain;
		if (!param) return;
		const now = this.ctx.currentTime;
		hold(param, now);
		param.setValueAtTime(1, now);
	}

	setVolume(level: number, muted: boolean) {
		const value = muted ? 0 : Math.max(0, Math.min(1, level));
		this.volume.gain.setTargetAtTime(value, this.ctx.currentTime, RAMP_S);
	}

	/** Called next to every `audio.play()`; inside a tap this is what unlocks the context. */
	resume() {
		clearTimeout(this.idleTimer);
		if (this.ctx.state === 'running') return;
		this.ctx.resume().catch((e: unknown) => logPlayback('webaudio-resume-failed', String(e)));
	}

	/**
	 * A new track started loading. A lossless file needs nothing measured; a lossy
	 * one is measured while the enhancer is on, keeping the previous lossy track's
	 * cutoff meanwhile, which usually fits (same album, same source).
	 */
	trackChanged(lossless: boolean) {
		this.lossless = lossless;
		this.detector.stop();
		this.setSource({ lossless, cutoff: lossless ? null : this.lastLossyCutoff });
		if (!lossless && audioSettings.enhancer) this.detector.start();
	}

	private setSource(source: EnhancerSource) {
		this.source = source;
		if (!source.lossless) this.lastLossyCutoff = source.cutoff;
		this.enhancer.setSource(source);
		this.onSource(source);
	}

	dispose() {
		clearTimeout(this.idleTimer);
		for (const el of this.elements) {
			el.removeEventListener('play', this.onElementPlay);
			for (const type of ['pause', 'ended', 'emptied']) el.removeEventListener(type, this.onElementIdle);
		}
		this.detector.stop();
		this.stopSettings();
		this.ctx.removeEventListener('statechange', this.onStateChange);
		for (const type of this.unlockEvents) document.removeEventListener(type, this.unlock, true);
		void this.ctx.close().catch(() => {});
	}

	private unlock = () => {
		if (this.ctx.state === 'running') {
			for (const type of this.unlockEvents) document.removeEventListener(type, this.unlock, true);
			return;
		}
		this.resume();
	};

	// iOS suspends (or 'interrupts') the context for calls, Siri and sometimes the
	// lock screen; the element keeps "playing" in silence. Ask for it back.
	private onElementPlay = () => this.resume();

	/** An element stopped: once none plays for a while, let the context sleep. */
	private onElementIdle = () => {
		clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => {
			const silent = [...this.elements].every((el) => el.paused);
			if (!silent || this.wantsSound() || this.ctx.state !== 'running') return;
			logPlayback('webaudio-idle', 'suspend');
			this.detector.stop();
			this.ctx.suspend().catch(() => {});
		}, IDLE_SUSPEND_MS);
	};

	private onStateChange = () => {
		logPlayback('webaudio-state', this.ctx.state);
		if (this.ctx.state !== 'running' && this.ctx.state !== 'closed' && this.wantsSound()) this.resume();
	};

	private applySettings() {
		this.applyEq();
		this.applyEnhancer();
	}

	private applyEq() {
		const on = audioSettings.eqEnabled && audioSettings.gains.some((g) => g !== 0);
		const now = this.ctx.currentTime;
		for (let i = 0; i < EQ_BAND_COUNT; i++) {
			this.filters[i].gain.setTargetAtTime(on ? (audioSettings.gains[i] ?? 0) : 0, now, RAMP_S);
		}
		// Headroom for boosts, so a bass-heavy preset doesn't clip loud masters.
		const peak = on ? Math.max(0, ...audioSettings.gains) : 0;
		this.preamp.gain.setTargetAtTime(10 ** (-peak / 2 / 20), now, RAMP_S);

		if (on === this.eqRouted) return;
		// Only that edge: the cutoff detector's analyser may be tapping the bus too.
		if (this.eqRouted !== null) this.bus.disconnect(this.eqRouted ? this.preamp : this.eqOut);
		this.eqRouted = on;
		// Off: skip the filters entirely (they still exist, just out of the path).
		this.bus.connect(on ? this.preamp : this.eqOut);
	}

	private applyEnhancer() {
		const on = audioSettings.enhancer;
		this.enhancer.setLevel(audioSettings.enhancerLevel);
		if (on === this.enhancerRouted) return;
		const first = this.enhancerRouted === null;
		if (!first) this.eqOut.disconnect(this.enhancerRouted ? this.enhancer.input : this.volume);
		this.enhancerRouted = on;
		this.eqOut.connect(on ? this.enhancer.input : this.volume);
		// Turned on mid-track: measure the track already playing.
		if (on && !first && !this.lossless) this.detector.start();
		else if (!on) this.detector.stop();
	}
}
