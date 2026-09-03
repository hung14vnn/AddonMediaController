import { EQ_FREQUENCIES, EQ_BAND_COUNT, EQ_MIN_GAIN, EQ_MAX_GAIN } from '../stores/eqPresets';

const DEFAULT_Q = 1.4;
// Small FFT keeps per-frame visualiser reads cheap; 128 yields 64 bins.
const ANALYSER_FFT_SIZE = 128;

export interface AuxiliaryAudioConnection {
	setGain(level: number): void;
	destroy(): void;
}

export class AudioEngine {
	private context: AudioContext | null = null;
	private source: MediaElementAudioSourceNode | null = null;
	private filters: BiquadFilterNode[] = [];
	private analyser: AnalyserNode | null = null;
	private freqData: Uint8Array<ArrayBuffer> | null = null;
	private connectedElement: HTMLAudioElement | null = null;
	private contextStateHandler: (() => void) | null = null;

	connect(audio: HTMLAudioElement): void {
		if (this.connectedElement === audio) return;
		if (this.connectedElement) {
			this.destroy();
		}

		try {
			this.context = new AudioContext();
			this.source = this.context.createMediaElementSource(audio);
			const context = this.context;
			this.contextStateHandler = () => {
				if (
					context.state === 'suspended' &&
					this.connectedElement &&
					!this.connectedElement.paused
				) {
					void context.resume().catch(() => {
						// A backgrounded browser may reject resume until it is foregrounded.
					});
				}
			};
			context.addEventListener?.('statechange', this.contextStateHandler);

			this.filters = EQ_FREQUENCIES.map((freq) => {
				const filter = this.context!.createBiquadFilter();
				filter.type = 'peaking';
				filter.frequency.value = freq;
				filter.Q.value = DEFAULT_Q;
				filter.gain.value = 0;
				return filter;
			});

			let prev: AudioNode = this.source;
			for (const filter of this.filters) {
				prev.connect(filter);
				prev = filter;
			}
			prev.connect(this.context.destination);

			// Analyser is a terminal sink (not connected onward), so it never alters the audio.
			if (typeof this.context.createAnalyser === 'function') {
				this.analyser = this.context.createAnalyser();
				this.analyser.fftSize = ANALYSER_FFT_SIZE;
				this.analyser.smoothingTimeConstant = 0.82;
				prev.connect(this.analyser);
			}

			this.connectedElement = audio;
		} catch (error) {
			// createMediaElementSource/filter setup can fail (for example because
			// an element was already attached to another context). Never leave a
			// partially-created context alive when that happens.
			this.destroy();
			throw error;
		}
	}

	/**
	 * Current frequency spectrum (0-255 per bin) for the visualiser, or null when
	 * no analyser is available. The buffer is owned and reused across frames.
	 */
	getFrequencyData(): Uint8Array | null {
		if (!this.analyser) return null;
		if (!this.freqData || this.freqData.length !== this.analyser.frequencyBinCount) {
			this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
		}
		this.analyser.getByteFrequencyData(this.freqData);
		return this.freqData;
	}

	setBandGain(index: number, dB: number): void {
		if (index < 0 || index >= EQ_BAND_COUNT || !this.filters[index]) return;
		this.filters[index].gain.value = Math.max(EQ_MIN_GAIN, Math.min(EQ_MAX_GAIN, dB));
	}

	setAllGains(gains: readonly number[]): void {
		for (let i = 0; i < EQ_BAND_COUNT; i++) {
			if (this.filters[i]) {
				this.filters[i].gain.value = Math.max(EQ_MIN_GAIN, Math.min(EQ_MAX_GAIN, gains[i] ?? 0));
			}
		}
	}

	setEnabled(enabled: boolean, storedGains: readonly number[]): void {
		if (enabled) {
			this.setAllGains(storedGains);
		} else {
			for (const filter of this.filters) {
				filter.gain.value = 0;
			}
		}
	}

	getFrequencies(): readonly number[] {
		return EQ_FREQUENCIES;
	}

	isConnected(): boolean {
		return this.connectedElement !== null;
	}

	connectAuxiliary(audio: HTMLAudioElement): AuxiliaryAudioConnection | null {
		if (!this.context) return null;
		const source = this.context.createMediaElementSource(audio);
		const gain = this.context.createGain();
		source.connect(gain);
		gain.connect(this.filters[0] ?? this.context.destination);
		return {
			setGain: (level: number) => {
				const value = Math.max(0, Math.min(1, level));
				gain.gain.cancelScheduledValues(this.context!.currentTime);
				gain.gain.setTargetAtTime(value, this.context!.currentTime, 0.03);
			},
			destroy: () => {
				source.disconnect();
				gain.disconnect();
			}
		};
	}

	async resume(): Promise<void> {
		if (this.context && this.context.state === 'suspended') {
			await this.context.resume();
		}
	}

	destroy(): void {
		if (this.context && this.contextStateHandler) {
			this.context.removeEventListener?.('statechange', this.contextStateHandler);
		}
		for (const filter of this.filters) {
			filter.disconnect();
		}
		this.analyser?.disconnect();
		this.source?.disconnect();
		if (this.context && this.context.state !== 'closed') {
			void this.context.close();
		}
		this.filters = [];
		this.analyser = null;
		this.freqData = null;
		this.source = null;
		this.context = null;
		this.connectedElement = null;
		this.contextStateHandler = null;
	}
}
