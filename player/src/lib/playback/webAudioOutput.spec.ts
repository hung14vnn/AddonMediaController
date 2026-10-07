import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeParam {
	value = 1;
	curve: Float32Array | null = null;
	setTargetAtTime(v: number) {
		this.value = v;
	}
	setValueAtTime(v: number) {
		this.value = v;
		this.curve = null;
	}
	setValueCurveAtTime(curve: Float32Array) {
		this.curve = curve;
		this.value = curve[curve.length - 1];
	}
	cancelAndHoldAtTime() {}
	cancelScheduledValues() {}
}

class FakeNode {
	targets = new Set<FakeNode>();
	gain = new FakeParam();
	frequency = new FakeParam();
	Q = new FakeParam();
	type = '';
	curve: Float32Array | null = null;
	constructor(public kind = 'gain') {
		FakeContext.last?.nodes.push(this);
	}
	connect(n: FakeNode) {
		this.targets.add(n);
		return n;
	}
	disconnect(n?: FakeNode) {
		if (n) this.targets.delete(n);
		else this.targets.clear();
	}
}

class FakeContext extends EventTarget {
	static last: FakeContext;
	nodes: FakeNode[] = [];
	state: AudioContextState = 'suspended';
	currentTime = 0;
	destination!: FakeNode;
	sources: FakeNode[] = [];
	resume = vi.fn(async () => {
		this.state = 'running';
	});
	close = vi.fn(async () => {});
	suspend = vi.fn(async () => {
		this.state = 'suspended';
	});
	constructor() {
		super();
		FakeContext.last = this;
		this.destination = new FakeNode('destination');
	}
	createGain() {
		return new FakeNode();
	}
	createBiquadFilter() {
		return new FakeNode('biquad');
	}
	createWaveShaper() {
		return new FakeNode('shaper');
	}
	createChannelSplitter() {
		return new FakeNode('splitter');
	}
	createChannelMerger() {
		return new FakeNode('merger');
	}
	createMediaElementSource() {
		const n = new FakeNode('source');
		this.sources.push(n);
		return n;
	}
}

/** Every node reachable from `from`. */
function reachable(from: FakeNode, seen = new Set<FakeNode>()): Set<FakeNode> {
	for (const n of from.targets) {
		if (!seen.has(n)) {
			seen.add(n);
			reachable(n, seen);
		}
	}
	return seen;
}

describe('WebAudioOutput', () => {
	beforeEach(() => {
		localStorage.clear();
		vi.resetModules();
		vi.stubGlobal('AudioContext', FakeContext);
	});
	afterEach(() => vi.unstubAllGlobals());

	async function load(wantsSound = () => true) {
		const { audioSettings } = await import('./audioSettings.svelte');
		const { WebAudioOutput } = await import('./webAudioOutput');
		const output = new WebAudioOutput(wantsSound);
		const ctx = FakeContext.last;
		output.attach(document.createElement('audio'));
		const source = ctx.sources[0];
		const path = () => [...reachable(source)];
		const volume = ctx.nodes.find((n) => n.targets.has(ctx.destination))!;
		return { audioSettings, output, ctx, source, path, volume };
	}

	it('joins an element once and reaches the speakers with nothing in between by default', async () => {
		const { output, ctx, path } = await load();
		const el = document.createElement('audio');
		output.attach(el);
		output.attach(el);
		expect(ctx.sources).toHaveLength(2); // load()'s element and this one, once each
		expect(path()).toContain(ctx.destination);
		expect(path().some((n) => n.kind === 'biquad' || n.kind === 'shaper')).toBe(false);
		output.dispose();
	});

	it('splices the EQ in only while it is on', async () => {
		const { audioSettings, output, ctx, path } = await load();
		audioSettings.setPreset('Bass Booster');
		const peaking = path().filter((n) => n.kind === 'biquad' && n.type === 'peaking');
		expect(peaking).toHaveLength(10);
		expect(peaking[0].gain.value).toBe(5.5);
		expect(path()).toContain(ctx.destination);

		audioSettings.setEqEnabled(false);
		expect(path().some((n) => n.kind === 'biquad')).toBe(false);
		output.dispose();
	});

	it('adds the Sound Enhancer between the EQ and the volume', async () => {
		const { audioSettings, output, ctx, path } = await load();
		audioSettings.setEnhancer(true);
		expect(path().some((n) => n.kind === 'shaper')).toBe(true);
		expect(path().some((n) => n.kind === 'biquad' && n.type === 'peaking')).toBe(false);
		expect(path()).toContain(ctx.destination);

		audioSettings.setPreset('Rock');
		expect(path().some((n) => n.kind === 'shaper')).toBe(true);
		expect(path().some((n) => n.type === 'peaking')).toBe(true);

		audioSettings.setEnhancer(false);
		expect(path().some((n) => n.kind === 'shaper')).toBe(false);
		output.dispose();
	});

	it('controls volume with a gain node and mutes to zero', async () => {
		const { output, volume } = await load();
		output.setVolume(0.4, false);
		expect(volume.gain.value).toBeCloseTo(0.4);
		output.setVolume(0.4, true);
		expect(volume.gain.value).toBe(0);
		output.dispose();
	});

	it('crossfades two elements with equal-power curves and resets a cut', async () => {
		const { output, ctx } = await load();
		const a = document.createElement('audio');
		const b = document.createElement('audio');
		output.attach(a);
		output.attach(b);
		// source → trim → fade, per element
		const fadeOf = (i: number) => [...ctx.sources[i].targets][0].targets.values().next().value!;
		const [fadeA, fadeB] = [fadeOf(1), fadeOf(2)];
		output.crossfade(a, b, 4);
		expect(fadeA.gain.curve![0]).toBeCloseTo(1);
		expect(fadeA.gain.value).toBeCloseTo(0);
		expect(fadeB.gain.curve![0]).toBeCloseTo(0);
		// Equal power: halfway, both at ~0.707 rather than 0.5.
		const mid = Math.floor(fadeB.gain.curve!.length / 2);
		expect(fadeA.gain.curve![mid] ** 2 + fadeB.gain.curve![mid] ** 2).toBeCloseTo(1, 1);
		output.resetFade(a);
		expect(fadeA.gain.value).toBe(1);
		output.dispose();
	});

	it("applies ReplayGain on the element's own trim gain", async () => {
		const { output, ctx } = await load();
		const el = document.createElement('audio');
		output.attach(el);
		const trim = [...ctx.sources[1].targets][0];
		output.setTrim(el, 0.5);
		expect(trim.gain.value).toBe(0.5);
		output.dispose();
	});

	it('suspends the context once nothing has played for a while, resumes on play', async () => {
		vi.useFakeTimers();
		const { output, ctx } = await load(() => false);
		ctx.state = 'running';
		const el = document.createElement('audio');
		output.attach(el);
		// jsdom elements report paused; a pause event starts the idle countdown.
		el.dispatchEvent(new Event('pause'));
		vi.advanceTimersByTime(9_000);
		expect(ctx.suspend).not.toHaveBeenCalled();
		vi.advanceTimersByTime(2_000);
		expect(ctx.suspend).toHaveBeenCalled();
		el.dispatchEvent(new Event('play'));
		expect(ctx.resume).toHaveBeenCalled();
		output.dispose();
		vi.useRealTimers();
	});

	it('keeps the context awake while the player wants sound', async () => {
		vi.useFakeTimers();
		const { WebAudioOutput } = await import('./webAudioOutput');
		const output = new WebAudioOutput(() => true);
		const ctx = FakeContext.last;
		ctx.state = 'running';
		const el = document.createElement('audio');
		output.attach(el);
		el.dispatchEvent(new Event('emptied')); // a track change
		vi.advanceTimersByTime(20_000);
		expect(ctx.suspend).not.toHaveBeenCalled();
		output.dispose();
		vi.useRealTimers();
	});

	it('resumes the suspended context on the first tap', async () => {
		const { output, ctx } = await load();
		document.dispatchEvent(new Event('pointerdown'));
		expect(ctx.resume).toHaveBeenCalled();
		output.dispose();
		expect(ctx.close).toHaveBeenCalled();
	});
});

describe('audioSettings', () => {
	beforeEach(() => {
		localStorage.clear();
		vi.resetModules();
	});

	it('keeps the engine the page started with until a restart', async () => {
		const { audioSettings } = await import('./audioSettings.svelte');
		expect(audioSettings.activeEngine).toBe('element');
		audioSettings.setEngine('webaudio');
		expect(audioSettings.restartNeeded).toBe(true);

		audioSettings.flush();
		vi.resetModules();
		const reloaded = (await import('./audioSettings.svelte')).audioSettings;
		expect(reloaded.activeEngine).toBe('webaudio');
		expect(reloaded.restartNeeded).toBe(false);
	});

	it('marks a dragged band as Custom and persists it', async () => {
		const { audioSettings } = await import('./audioSettings.svelte');
		audioSettings.setPreset('Rock');
		audioSettings.setBand(0, 40);
		expect(audioSettings.preset).toBe('Custom');
		expect(audioSettings.gains[0]).toBe(12);

		audioSettings.flush();
		vi.resetModules();
		const reloaded = (await import('./audioSettings.svelte')).audioSettings;
		expect(reloaded.preset).toBe('Custom');
		expect(reloaded.gains[0]).toBe(12);
		expect(reloaded.eqEnabled).toBe(true);
	});
});

describe('audioSettings: Sound Enhancer', () => {
	beforeEach(() => {
		localStorage.clear();
		vi.resetModules();
	});

	it('persists the switch and clamps the level', async () => {
		const { audioSettings } = await import('./audioSettings.svelte');
		audioSettings.setEnhancer(true);
		audioSettings.setEnhancerLevel(3);
		audioSettings.flush();
		vi.resetModules();
		const reloaded = (await import('./audioSettings.svelte')).audioSettings;
		expect(reloaded.enhancer).toBe(true);
		expect(reloaded.enhancerLevel).toBe(1);
	});
});

describe('ReplayGain', () => {
	it('uses album gain only while an album plays in order', async () => {
		const { gainModeFor } = await import('./replayGain');
		const queue = [{ id: '1', title: 'a', albumId: 'x' }, { id: '2', title: 'b', albumId: 'x' }, { id: '3', title: 'c', albumId: 'y' }];
		expect(gainModeFor(queue, 0, false)).toBe('album');
		expect(gainModeFor(queue, 0, true)).toBe('track');
		expect(gainModeFor(queue, 2, false)).toBe('track');
	});

	it('converts dB to linear and keeps the peak from clipping', async () => {
		const { replayGainFactor } = await import('./replayGain');
		const song = (replayGain: object) => ({ id: '1', title: 't', replayGain });
		expect(replayGainFactor(song({ trackGain: -6 }), 'track')).toBeCloseTo(0.501, 3);
		// +6 dB would push a 0.9 peak past full scale: held at 1/0.9.
		expect(replayGainFactor(song({ trackGain: 6, trackPeak: 0.9 }), 'track')).toBeCloseTo(1 / 0.9);
		// No album gain: falls back to the track's.
		expect(replayGainFactor(song({ trackGain: -3 }), 'album')).toBeCloseTo(10 ** (-3 / 20));
		expect(replayGainFactor({ id: 'yt-1', title: 't' }, 'track')).toBe(1);
	});
});
