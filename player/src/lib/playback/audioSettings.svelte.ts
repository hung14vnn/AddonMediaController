// Audio output settings, kept on this device. `engine` picks how the player makes
// sound: 'element' plays straight from <audio> (the default: most reliable in the
// background on iOS); 'webaudio' routes it through Web Audio for volume on iOS and
// the equalizer, Sound Enhancer, Sound Check and crossfade. The player is built for
// one engine, so a change applies on restart.
import { clampDb, EQ_BAND_COUNT, EQ_PRESETS, type EqPresetName } from './eqPresets';

export type AudioEngine = 'element' | 'webaudio';
export type EqPreset = EqPresetName | 'Custom';

const STORAGE_KEY = 'music.audio';
const FLAT: readonly number[] = EQ_PRESETS.Flat;

interface Stored {
	engine?: AudioEngine;
	eqEnabled?: boolean;
	preset?: EqPreset;
	gains?: number[];
	enhancer?: boolean;
	enhancerLevel?: number;
	crossfade?: boolean;
	soundCheck?: boolean;
}

function read(): Stored {
	try {
		return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Stored;
	} catch {
		return {};
	}
}

function clampLevel(level: number) {
	return Math.max(0, Math.min(1, Number.isFinite(level) ? level : 0.5));
}

class AudioSettings {
	engine = $state<AudioEngine>('element');
	eqEnabled = $state(false);
	preset = $state<EqPreset>('Flat');
	gains = $state<number[]>([...FLAT]);
	/** Sound Enhancer (Web Audio): adds high harmonics and width to compressed audio. */
	enhancer = $state(false);
	/** 0 (low) … 1 (high). */
	enhancerLevel = $state(0.5);
	/** Crossfade (Web Audio): each song fades into the next when it ends by itself. */
	crossfade = $state(false);
	/** Sound Check (Web Audio): ReplayGain, so songs play at about the same loudness. */
	soundCheck = $state(false);
	/** The engine this page load's player was built with. */
	readonly activeEngine: AudioEngine;
	private listeners = new Set<() => void>();

	constructor() {
		const s = read();
		if (s.engine === 'webaudio') this.engine = 'webaudio';
		this.eqEnabled = s.eqEnabled === true;
		if (s.preset && (s.preset === 'Custom' || s.preset in EQ_PRESETS)) this.preset = s.preset;
		if (Array.isArray(s.gains) && s.gains.length === EQ_BAND_COUNT) this.gains = s.gains.map(clampDb);
		this.enhancer = s.enhancer === true;
		if (typeof s.enhancerLevel === 'number') this.enhancerLevel = clampLevel(s.enhancerLevel);
		this.crossfade = s.crossfade === true;
		this.soundCheck = s.soundCheck === true;
		this.activeEngine = this.engine;
	}

	/** The engine was changed and the app hasn't restarted onto it yet. */
	get restartNeeded() {
		return this.engine !== this.activeEngine;
	}

	setEngine(engine: AudioEngine) {
		this.engine = engine;
		this.save();
	}

	setEqEnabled(on: boolean) {
		this.eqEnabled = on;
		this.changed();
	}

	setPreset(name: EqPresetName) {
		this.preset = name;
		this.gains = [...EQ_PRESETS[name]];
		this.eqEnabled = true;
		this.changed();
	}

	setBand(index: number, db: number) {
		if (index < 0 || index >= EQ_BAND_COUNT) return;
		const gains = [...this.gains];
		gains[index] = clampDb(db);
		this.gains = gains;
		this.preset = 'Custom';
		this.changed();
	}

	setEnhancer(on: boolean) {
		this.enhancer = on;
		this.changed();
	}

	setEnhancerLevel(level: number) {
		this.enhancerLevel = clampLevel(level);
		this.changed();
	}

	/** Read at each track change; nothing to apply now. */
	setCrossfade(on: boolean) {
		this.crossfade = on;
		this.save();
	}

	setSoundCheck(on: boolean) {
		this.soundCheck = on;
		this.changed();
	}

	/** Called on every EQ or enhancer change; returns the unsubscribe. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private changed() {
		this.save();
		for (const listener of this.listeners) listener();
	}

	private save() {
		try {
			const stored: Stored = {
				engine: this.engine,
				eqEnabled: this.eqEnabled,
				preset: this.preset,
				gains: this.gains,
				enhancer: this.enhancer,
				enhancerLevel: this.enhancerLevel,
				crossfade: this.crossfade,
				soundCheck: this.soundCheck
			};
			localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
		} catch {
			/* storage unavailable: settings last for this session */
		}
	}
}

export const audioSettings = new AudioSettings();
