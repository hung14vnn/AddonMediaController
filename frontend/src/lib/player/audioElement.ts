import { AudioEngine } from './audioEngine';

let audioElement: HTMLAudioElement | null = null;
let engine: AudioEngine | null = null;

type StandaloneNavigator = Navigator & { standalone?: boolean };

/**
 * Keep iOS/iPadOS playback on the native media element. WebKit may suspend a Web
 * Audio graph in an installed PWA, and some iOS versions do not reliably expose
 * `display-mode: standalone`; using the device check avoids creating a context by
 * accident and lets iOS own the audio session (including lock-screen playback).
 */
export function usesNativeBackgroundPlayback(): boolean {
	if (typeof navigator === 'undefined') return false;
	const nav = navigator as StandaloneNavigator;
	return (
		/iPad|iPhone|iPod/.test(nav.userAgent) ||
		(nav.platform === 'MacIntel' && nav.maxTouchPoints > 1)
	);
}

export function setAudioElement(el: HTMLAudioElement): void {
	if (audioElement === el) return;
	if (engine) {
		engine.destroy();
		engine = null;
	}
	audioElement = el;
	// Context creation is deferred until playback starts. This keeps mobile
	// playback lightweight until the user actually enables or starts using EQ.
}

export function ensureAudioEngine(): AudioEngine | null {
	if (engine || !audioElement) return engine;
	try {
		const newEngine = new AudioEngine();
		newEngine.connect(audioElement);
		engine = newEngine;
	} catch {
		// connect() can throw (InvalidStateError, SecurityError).
		// Audio element is still usable without EQ — engine stays null.
	}
	return engine;
}

export function getAudioElement(): HTMLAudioElement {
	if (!audioElement) {
		throw new Error('Audio element not mounted — setAudioElement() must be called before playback');
	}
	return audioElement;
}

export function getAudioEngine(): AudioEngine {
	ensureAudioEngine();
	if (!engine) {
		throw new Error('Audio engine not initialized — setAudioElement() must be called first');
	}
	return engine;
}

export function tryGetAudioEngine(): AudioEngine | null {
	return engine;
}

export async function resumeAudioEngine(): Promise<void> {
	try {
		// Playback paths call this before every play(). On iOS, creating the
		// graph here would pull every track off WebKit's native media pipeline
		// and onto a real-time render thread for its whole duration, a steady
		// thermal cost even with a pass-through graph. Only resume an engine the
		// EQ store already created via ensureAudioEngine(); never create one.
		await engine?.resume();
	} catch {
		// Browsers can reject resume() outside a user activation. Native audio
		// playback should still continue; the next user gesture can retry.
	}
}

/**
 * Put the graph to sleep while nothing is playing.
 *
 * A running AudioContext keeps a real-time render thread alive even when the
 * element feeding it is paused, so leaving it running across a long pause is a
 * steady, invisible battery and thermal cost on mobile. `resumeAudioEngine()`
 * brings it back, and playback paths already call that before `play()`.
 */
export async function suspendAudioEngine(): Promise<void> {
	try {
		await engine?.suspend();
	} catch {
		// Suspension is an optimisation: a browser that refuses it just keeps
		// the context running, which is the previous behaviour.
	}
}

export function _resetAudioElement(): void {
	engine?.destroy();
	engine = null;
	audioElement = null;
}
