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
	if (usesNativeBackgroundPlayback()) return;
	// Context creation is deferred until playback starts. iOS Home Screen PWAs can
	// leave a context created during app startup permanently suspended.
}

export function ensureAudioEngine(): AudioEngine | null {
	if (engine || !audioElement || usesNativeBackgroundPlayback()) return engine;
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
		ensureAudioEngine();
		await engine?.resume();
	} catch {
		// Browsers can reject resume() outside a user activation. Native audio
		// playback should still continue; the next user gesture can retry.
	}
}

export function _resetAudioElement(): void {
	engine?.destroy();
	engine = null;
	audioElement = null;
}
