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

/** Remote Playback API: Chromecast etc. on Chrome/Android, AirPlay on Safari. */
export function watchRemotePlayback(audio: HTMLAudioElement, listener: RemotePlaybackListener) {
	const remote = remoteOf(audio);
	if (!remote) return;
	remote.watchAvailability((available) => listener.availability(available)).catch(() => {
		// Some browsers can't monitor continuously; assume a picker may exist.
		listener.availability(true);
	});
	let stallTimer: ReturnType<typeof setTimeout> | undefined;
	const sync = () => {
		listener.state(remote.state, false);
		clearTimeout(stallTimer);
		if (remote.state === 'connecting') {
			stallTimer = setTimeout(() => {
				if (remote.state === 'connecting') listener.state(remote.state, true);
			}, CAST_STALL_MS);
		}
	};
	remote.addEventListener('connecting', sync);
	remote.addEventListener('connect', sync);
	remote.addEventListener('disconnect', sync);
	// Events only report changes; a reload mid-AirPlay would otherwise show "This Device".
	sync();
}

export async function pickOutput(audio: HTMLAudioElement): Promise<boolean> {
	// Try local device picker first (Chrome/Edge on Windows/Android).
	if ('setSinkId' in audio && navigator.mediaDevices && 'selectAudioOutput' in navigator.mediaDevices) {
		try {
			const device = await (navigator.mediaDevices as any).selectAudioOutput();
			await (audio as any).setSinkId(device.deviceId);
			return true;
		} catch (e) {
			// NotAllowedError = user dismissed the picker, which still counts as shown.
			if (e instanceof DOMException && e.name === 'NotAllowedError') return true;
			// For other errors, fall through to Remote Playback.
		}
	}

	const remote = remoteOf(audio);
	if (!remote) return false;
	try {
		await remote.prompt();
		return true;
	} catch (e) {
		// NotAllowedError = user dismissed the picker, which still counts as shown.
		return e instanceof DOMException && e.name === 'NotAllowedError';
	}
}
