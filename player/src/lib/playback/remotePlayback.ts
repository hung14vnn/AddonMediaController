/** An AirPlay/Cast route still connecting after this long is treated as stuck. */
const CAST_STALL_MS = 6_000;

export type CastState = 'disconnected' | 'connecting' | 'connected';

export interface RemotePlaybackListener {
	availability(available: boolean): void;
	/**
	 * `stalled`: still 'connecting' after CAST_STALL_MS. iOS has already moved the
	 * audio off the iPhone by then, so playback runs on in silence until the user
	 * picks a device.
	 */
	state(state: CastState, stalled: boolean): void;
}

const remoteOf = (audio: HTMLAudioElement) => (audio as HTMLAudioElement & { remote?: RemotePlayback }).remote;

interface AudioOutputMediaDevices extends MediaDevices {
	selectAudioOutput?: () => Promise<MediaDeviceInfo>;
}

/** Newer DOM typings declare setSinkId, but Safari and older browsers still lack it. */
type SinkableAudioElement = Omit<HTMLAudioElement, 'setSinkId'> & {
	setSinkId?: (sinkId: string) => Promise<void>;
};

/** Remote Playback API: Chromecast etc. on Chrome/Android, AirPlay on Safari. */
export function watchRemotePlayback(audio: HTMLAudioElement, listener: RemotePlaybackListener): () => void {
	const remote = remoteOf(audio);
	if (!remote) return () => {};
	let stopped = false;
	remote.watchAvailability((available) => listener.availability(available)).catch(() => {
		// Some browsers can't monitor continuously; assume a picker may exist.
		listener.availability(true);
	});
	let stallTimer: ReturnType<typeof setTimeout> | undefined;
	const sync = () => {
		listener.state(remote.state, false);
		clearTimeout(stallTimer);
		if (!stopped && remote.state === 'connecting') {
			stallTimer = setTimeout(() => {
				if (!stopped && remote.state === 'connecting') listener.state(remote.state, true);
			}, CAST_STALL_MS);
		}
	};
	remote.addEventListener('connecting', sync);
	remote.addEventListener('connect', sync);
	remote.addEventListener('disconnect', sync);
	// Events only report changes; a reload mid-AirPlay would otherwise show "This Device".
	sync();
	return () => {
		stopped = true;
		clearTimeout(stallTimer);
		remote.removeEventListener('connecting', sync);
		remote.removeEventListener('connect', sync);
		remote.removeEventListener('disconnect', sync);
		const cancel = (remote as RemotePlayback & { cancelWatchAvailability?: () => Promise<void> }).cancelWatchAvailability;
		if (cancel) void cancel.call(remote).catch(() => {});
	};
}

async function pickLocalOutput(audio: HTMLAudioElement): Promise<boolean | null> {
	const mediaDevices = navigator.mediaDevices as AudioOutputMediaDevices | undefined;
	const sinkableAudio = audio as SinkableAudioElement;
	if (!mediaDevices?.selectAudioOutput || !sinkableAudio.setSinkId) return null;

	try {
		const device = await mediaDevices.selectAudioOutput();
		await sinkableAudio.setSinkId(device.deviceId);
		return true;
	} catch (e) {
		// NotAllowedError means the user closed the native picker.
		if (e instanceof DOMException && e.name === 'NotAllowedError') return true;
		return false;
	}
}

export async function pickOutput(audio: HTMLAudioElement): Promise<boolean> {
	const remote = remoteOf(audio);
	const isAndroid = /Android/i.test(navigator.userAgent);
	let remoteAttempted = false;

	// Android Chromium exposes Remote Playback but not the local output picker.
	// Calling another async API first consumes the click's user activation and
	// makes remote.prompt() fail with NotAllowedError.
	if (isAndroid && remote) {
		remoteAttempted = true;
		try {
			await remote.prompt();
			return true;
		} catch (e) {
			// The picker was shown and closed; do not start another async picker
			// after the click's user activation has already been consumed.
			if (e instanceof DOMException && e.name === 'NotAllowedError') return true;
		}
	}

	// Windows Chromium supports selecting an audio output directly. Keep this
	// as the first async operation on desktop so the native picker retains the
	// activation from the button click.
	const localResult = await pickLocalOutput(audio);
	if (localResult !== null) return localResult;

	if (remote && !remoteAttempted) {
		try {
			await remote.prompt();
			return true;
		} catch (e) {
			// NotAllowedError means the user closed the native picker.
			return e instanceof DOMException && e.name === 'NotAllowedError';
		}
	}

	return false;
}
