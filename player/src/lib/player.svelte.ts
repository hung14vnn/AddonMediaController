import { getKaraoke, getPlayQueue, getSession, savePlayQueue, scrobble, streamUrl } from './api';
import { build, buildLabel } from './build';
import { isPlaybackLogEnabled, logPlayback } from './playback/debugLog';
import { audioSettings } from './playback/audioSettings.svelte';
import { isLossless, type EnhancerSource } from './playback/cutoffDetector';
import { InterruptionGuard } from './playback/interruptions';
import { clearMediaSession, setMediaMetadata, setMediaPosition, setupMediaSession } from './playback/mediaSession';
import {
	cycleRepeat,
	indexAfterUnshuffle,
	interleaveEvenly,
	moveItem,
	nextIndex,
	planPlayOrder,
	removeAt,
	shuffleAround,
	type Repeat
} from './playback/queue';
import { pickOutput, watchRemotePlayback, type CastState } from './playback/remotePlayback';
import { gainModeFor, replayGainFactor } from './playback/replayGain';
import { SingleTab } from './playback/singleTab';
import { WebAudioOutput } from './playback/webAudioOutput';
import { clearSnapshot, readSnapshot, writeSnapshot } from './playback/snapshot';
import { sleepTimer } from './sleepTimer.svelte';
import type { Song } from './types';

export type { Repeat };

interface ObjectUrl {
	url: string;
	revoke: () => void;
}

/** A downloaded (or fully prefetched) track's blob URL, tagged with the song it plays. */
interface OfflineCopy {
	id: string;
	copy: ObjectUrl;
}

interface BlobJob {
	id: string;
	abort: AbortController;
	/** Aborted by our own timeout (a failure), as opposed to superseded or unloaded. */
	timedOut: boolean;
}

interface BlobFailure {
	id: string;
	count: number;
	at: number;
	/** Not worth retrying (e.g. the file is too big to hold in memory). */
	final: boolean;
}

/** The Web Audio engine when the settings ask for it; plain <audio> if it can't start. */
function createOutput(
	wantsSound: () => boolean,
	onSource: (source: EnhancerSource) => void
): WebAudioOutput | null {
	if (audioSettings.activeEngine !== 'webaudio') return null;
	try {
		return new WebAudioOutput(wantsSound, onSource);
	} catch (e) {
		logPlayback('webaudio-unavailable', String(e));
		return null;
	}
}

function createManagedAudio(): HTMLAudioElement {
	const audio = new Audio();
	audio.setAttribute('aria-hidden', 'true');
	audio.style.position = 'fixed';
	audio.style.width = '1px';
	audio.style.height = '1px';
	audio.style.opacity = '0';
	audio.style.pointerEvents = 'none';
	document.body.appendChild(audio);
	return audio;
}

/** Park a native stream after 15 seconds without progress. */
const STALL_TIMEOUT_MS = 15_000;
/** Shortest wait between two stall checks (also the re-check while system-paused). */
const STALL_CHECK_MS = 2_000;
/**
 * A stall check that fires this much later than due was held by the OS (iOS releases
 * timers held in the background the moment the page is shown again), so its idea of
 * "no progress" is meaningless and it must not act on it.
 */
const STALL_LATE_MS = 5_000;

/**
 * Download the whole next track into RAM this early. Resolving a cold YouTube stream
 * on the server can take a minute (an 87 s download was observed), so start early.
 */
const BLOB_LEAD_S = 150;
/**
 * Same, for YouTube tracks (`yt-` ids), whose cold resolve is slow and whose first
 * attempt may fail at a proxy timeout (~80 s observed), so they need room for retries.
 */
const BLOB_LEAD_YT_S = 300;
/** A prefetched blob smaller than this is an error page or truncated, not audio. */
const MIN_BLOB_BYTES = 16 * 1024;
/** Longer files (lossless, long mixes) just stream instead of filling RAM. */
const MAX_BLOB_BYTES = 60 * 1024 * 1024;
/** A prefetch that takes longer than this is treated as failed. */
const BLOB_FETCH_TIMEOUT_MS = 150_000;
/** A failed prefetch is retried after this pause, up to MAX_BLOB_ATTEMPTS times. */
const BLOB_RETRY_GAP_MS = 4_000;
const MAX_BLOB_ATTEMPTS = 4;

/** HTMLMediaElement.HAVE_FUTURE_DATA. */
const HAVE_FUTURE_DATA = 3;

/**
 * An element "playing", with data to play, whose clock hasn't moved for this long is
 * frozen: iOS can resume one after a call (or Siri) without its sound coming back.
 */
const FROZEN_MS = 4_000;

/** Unplayable tracks skipped in a row before giving up. */
const MAX_ERROR_SKIPS = 2;
/** Pause before retrying or skipping a failed track, so a dead server isn't hammered. */
const ERROR_RETRY_DELAY_MS = 2_000;
/** Minimum gap between diagnostic probes of a failing source. */
const PROBE_MIN_GAP_MS = 10_000;
/** After this much successful playback, a later error counts as a new incident. */
const ERROR_REARM_AFTER_S = 10;

/** Media element events written to the playback log (timeupdate is too chatty). */
const LOGGED_EVENTS = ['play', 'pause', 'waiting', 'playing', 'canplay', 'stalled', 'ended', 'error', 'emptied', 'abort'];

/** A browser-reported length this much over the server's means the browser misread it. */
const DURATION_MISMATCH_RATIO = 1.25;

/**
 * Non-iOS: start the next track on the standby element this close to the end of the
 * current one, so some element is playing at every moment (see `swapToStandby`).
 */
const HANDOFF_LEAD_S = 0.6;

/**
 * Crossfade (Web Audio): the next song starts this long before the end, and the two
 * overlap for what's left once it is actually playing (see `startPreroll`). Songs
 * shorter than three times this just cut over.
 */
const CROSSFADE_S = 8;

/**
 * Non-iOS: when the next track isn't downloaded this close to the end (YouTube can
 * deliver a whole file slower than real time), load its stream into the standby element
 * instead, so the handoff still happens. The server has already resolved it for the
 * download, so buffering starts quickly.
 */
const STREAM_STANDBY_LEAD_S = 45;

/** A pause the page didn't ask for this soon after a track started is the system refusing it. */
const SYSTEM_PAUSE_WINDOW_MS = 2_000;

/** Lead time (seconds before the end) at which the whole-track prefetch of `id` starts. */
function blobLeadFor(id: string): number {
	return id.startsWith('yt-') ? BLOB_LEAD_YT_S : BLOB_LEAD_S;
}

/** iPadOS reports a Mac user agent; touch support tells them apart. */
function isIOSDevice(): boolean {
	return (
		/iPhone|iPad|iPod/i.test(navigator.userAgent) ||
		(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
	);
}

/** The downloaded copy of `id`, if the signed-in user has one. */
async function lookupOffline(id: string): Promise<ObjectUrl | null> {
	const session = getSession();
	if (!session?.username) return null;
	try {
		const { createOfflineTrackUrl } = await import('./offline');
		return await createOfflineTrackUrl(session.username, id);
	} catch {
		return null;
	}
}

/**
 * Single audio engine, modelled on Navidrome's web player: one <audio> element whose
 * src is swapped and load()ed on every track change, then played. The queue is the
 * play order; when shuffle is on, the original order is kept in `unshuffled` so
 * turning shuffle off restores it.
 *
 * Background note (iOS, and Android Chrome for slow YouTube streams): once audio
 * stops, the page may be frozen or throttled. So the track change in `ended` must be
 * fully synchronous: the next track is downloaded into a blob: URL while the current
 * one still plays (`prefetchNextBlob`), and `load()` takes it from `nextReady`
 * without any await. A cold server-side resolve (YouTube) is additionally triggered
 * as soon as the current track starts (`warmNext`), so that even if the blob is not
 * ready in time, the stream request at `ended` is answered quickly instead of leaving
 * a silent gap in which iOS suspends the page.
 *
 * Android: Chrome gives up audio focus while no element is playing, and after a few
 * minutes in the background Android refuses to grant it again, so a track started from
 * `ended` is paused by the system right away. So off iOS the prefetched next track is
 * loaded into a second, standby element and started just before the current one ends
 * (`swapToStandby`). iOS keeps the single element: it ties background playback to the
 * element that got the user's tap.
 */
class Player {
	queue = $state<Song[]>([]);
	index = $state(-1);
	playing = $state(false);
	buffering = $state(false);
	/**
	 * Playback position for the UI. While the page is hidden it is left alone (the
	 * reactive graph would otherwise re-run ~4×/s with the screen off) and caught
	 * up on `visibilitychange`. Engine logic uses `time`, which is always current.
	 */
	currentTime = $state(0);
	/** Always-current position (recovery reloads, snapshots, lock screen, seeking). */
	private time = 0;
	duration = $state(0);
	volume = $state(1);
	muted = $state(false);
	/** Web Audio: what the Sound Enhancer knows about the playing track (format, measured cutoff). */
	enhancerSource = $state<EnhancerSource | null>(null);
	shuffle = $state(false);
	repeat = $state<Repeat>('off');
	/** Karaoke: a karaoke version is playing in place of `original` (raw: compared by id). */
	karaoke = $state.raw<{ original: Song; version: Song } | null>(null);
	karaokeLoading = $state(false);
	error = $state<string | null>(null);
	/** Remote Playback API (Chromecast etc. on Chrome/Android; AirPlay picker on Safari). */
	castAvailable = $state(false);
	castState = $state<CastState>('disconnected');
	/** Stuck 'connecting': the audio has left the device but nothing plays it. */
	castStalled = $state(false);

	/** What the play/pause button shows: playing, or loading towards it (with a spinner). */
	active = $derived(this.playing || this.buffering);
	current = $derived(this.index >= 0 ? (this.queue[this.index] ?? null) : null);
	/** Tracks already passed in this play session, for the queue's History section. */
	history = $derived(this.index > 0 ? this.queue.slice(0, this.index) : []);
	upNext = $derived(this.queue.slice(this.index + 1));
	/** The song lyrics are for: the original while its karaoke version plays. */
	lyricsSong = $derived(
		this.karaoke && this.current?.id === this.karaoke.version.id ? this.karaoke.original : this.current
	);

	private audio: HTMLAudioElement;
	private readonly ios = isIOSDevice();
	/**
	 * Web Audio engine (Settings › Playback), or null for plain <audio>. Chosen once per
	 * page load: an element joined to a graph can't leave it, so a change needs a restart.
	 */
	private readonly output: WebAudioOutput | null = createOutput(
		() => this.playRequested,
		(source) => (this.enhancerSource = source)
	);
	/** Non-iOS: second element with the next track (`nextReady`) loaded and paused. */
	private standby: HTMLAudioElement | null = null;
	/** URL loaded into `standby`, or null when it holds nothing usable. */
	private standbyFor: string | null = null;
	/**
	 * The previous element after a handoff, still playing its last moments until the new
	 * one plays. `listeners` aborts the two one-shot handoff listeners once either has fired.
	 */
	private retiring: { el: HTMLAudioElement; copy: OfflineCopy | null; listeners: AbortController } | null = null;
	/** When the current element last fired `playing`. */
	private playingSince = -Infinity;
	/** Non-iOS: next track whose stream (not a downloaded copy) goes into the standby element. */
	private standbyStreamId: string | null = null;
	private unshuffled: Song[] | null = null;
	private scrobbled = false;
	private pendingSeek = 0;
	/** Invalidates a load still waiting on the offline lookup when another one starts. */
	private loadToken = 0;
	/** Offline/prefetched copy now playing, revoked on the next change. */
	private playingOffline: OfflineCopy | null = null;
	/**
	 * The upcoming track, ready to start without the network: either explicitly
	 * downloaded for offline use, or prefetched into a blob while the current track plays.
	 */
	private nextReady: OfflineCopy | null = null;
	/** Track id for which the offline lookup already came back empty (skips an await in load). */
	private offlineMissFor: string | null = null;
	/** In-flight whole-track prefetch, and the last failure (for bounded retries). */
	private blobJob: BlobJob | null = null;
	private blobFailure: BlobFailure | null = null;
	/**
	 * Track ids whose server-side resolve was already triggered by `warmNext`. Not
	 * aborted on track change: the server keeps (and caches) the work either way.
	 */
	private warmed = new Set<string>();
	/**
	 * Server length that playback ends at, or 0. iOS Safari misreads fragmented m4a
	 * (YouTube Music streams), often at about double, then plays silence up to it.
	 */
	private durationCap = 0;
	/** Playback is wanted: set by a play request, cleared by a pause that isn't a track change. */
	private playRequested = false;
	/** Playback failed while the page was hidden: retry once it is visible again. */
	private resumeWhenVisible = false;
	/** Track already reloaded once after a media error. */
	private errorRetriedFor: string | null = null;
	/** Tracks skipped in a row for errors; stops a dead server from cycling the queue. */
	private errorSkips = 0;
	private errorTimer: ReturnType<typeof setTimeout> | undefined;
	/** Queue index where the current run of errors started, to return to when giving up. */
	private errorOriginIndex = -1;
	/** loadToken whose error was already handled (one failure can raise several signals). */
	private errorHandledToken = -1;
	private lastProbeAt = 0;
	private stopDiagnostics: () => void = () => {};
	private stallTimer: ReturnType<typeof setTimeout> | undefined;
	/** Bumped whenever the watchdog is disarmed; a callback from an older generation is void. */
	private stallGen = 0;
	/** When the pending stall check is due (performance.now() scale), to detect late callbacks. */
	private stallDueAt = 0;
	private lastProgressAt = 0;
	private lastProgressTime = -1;
	/** 5 s slot of the last MediaSession position sync (see onTime). */
	private lastPositionSlot = -1;
	private saveTimer: ReturnType<typeof setTimeout> | undefined;
	private destroyed = false;
	private singleTab: SingleTab;
	private interruptions: InterruptionGuard;
	private stopRemoteWatch: () => void = () => {};
	private stopAudioSettings: () => void = () => {};
	/**
	 * Crossfade: the standby element already playing the next song under the end of
	 * this one (`fading` once its fade-in has begun).
	 */
	private preroll: { el: HTMLAudioElement; listeners: AbortController; fading: boolean } | null = null;

	constructor() {
		// Marks where each page load starts in the log, and which build it ran.
		logPlayback('app-start', `build=${buildLabel} built=${build.time} ua=${navigator.userAgent}`);
		// Remote Playback and audio-output selection are only exposed reliably for
		// media elements that belong to the document, not detached `new Audio()`
		// elements.
		this.audio = this.newElement();
		this.audio.preload = 'auto';
		this.singleTab = new SingleTab(() => this.pause());
		this.interruptions = new InterruptionGuard(this.audio, () => this.resumeAfterInterruption());

		this.bindElement(this.audio);
		this.bindActiveAudio(this.audio);

		// Have the offline chunk loaded before the page can be hidden, so a background
		// track change never has to fetch a JS chunk.
		void import('./offline').catch(() => {});

		this.stopDiagnostics = this.startDiagnostics();
		// Sound Check switched mid-song: apply it to the song playing.
		if (this.output) this.stopAudioSettings = audioSettings.onChange(() => this.applyReplayGain(true));

		window.addEventListener('pagehide', this.onPageHide);
		document.addEventListener('visibilitychange', this.onVisibilityChange);
		this.restore();
	}

	/**
	 * Playback log lines that show what the OS does to the page in the background:
	 * `freeze`/`resume` (Chrome freezing the tab), `net` (offline/online), and
	 * `timer-gap` (a 5 s timer that fired much later than due, i.e. timers were throttled).
	 * Together with the `probe` line on a media error they tell apart a throttled page
	 * or a cut network from a server/credential rejection. Returns a cleanup function.
	 */
	private startDiagnostics(): () => void {
		const onFreeze = () => logPlayback('lifecycle', 'freeze');
		const onResume = () => logPlayback('lifecycle', 'resume');
		const onOffline = () => logPlayback('net', 'offline');
		const onOnline = () => logPlayback('net', 'online');
		document.addEventListener('freeze', onFreeze);
		document.addEventListener('resume', onResume);
		window.addEventListener('offline', onOffline);
		window.addEventListener('online', onOnline);
		let lastBeat = performance.now();
		// The heartbeat only feeds the log, so don't wake the CPU every 5 s (audible
		// pages are exempt from background timer throttling) when logging is off.
		// Turning the log on takes effect from the next app start.
		const beat = isPlaybackLogEnabled() ? setInterval(() => {
			const now = performance.now();
			const gap = now - lastBeat;
			lastBeat = now;
			if (gap > 15_000) {
				logPlayback('timer-gap', `${Math.round(gap / 1000)}s hidden=${document.hidden} playing=${this.playing}`);
			}
		}, 5_000) : undefined;
		return () => {
			document.removeEventListener('freeze', onFreeze);
			document.removeEventListener('resume', onResume);
			window.removeEventListener('offline', onOffline);
			window.removeEventListener('online', onOnline);
			clearInterval(beat);
		};
	}

	/**
	 * Event flow follows Navidrome's player: a track change sets src and load()s,
	 * `canplay` (re)starts playback that is wanted, and a `waiting` element that
	 * already has enough buffered is kicked with play() again.
	 */
	private bindElement(a: HTMLAudioElement) {
		a.addEventListener('play', () => {
			if (this.audio !== a) return;
			this.playing = true;
			this.resumeWhenVisible = false;
			this.singleTab.announcePlaying();
		});
		a.addEventListener('pause', () => {
			if (this.audio !== a) return;
			this.playing = false;
			// Paused by the system right after a track started in the background, not by
			// us (our pauses clear playRequested first) and not a natural end: Android
			// refusing audio focus. Remember the request so opening the app resumes it.
			// Later pauses (headphones out, a call) are left alone.
			if (
				this.playRequested &&
				!a.ended &&
				document.hidden &&
				performance.now() - this.playingSince < SYSTEM_PAUSE_WINDOW_MS
			) {
				logPlayback('system-pause', `${Math.round(performance.now() - this.playingSince)}ms after start`);
				this.resumeWhenVisible = true;
			}
			// A pause that isn't part of a track change (end of track, headphones out)
			// drops the request, so a later `canplay` won't start playback by itself.
			if (!this.buffering) this.playRequested = false;
			this.persist(true);
		});
		a.addEventListener('waiting', () => {
			if (this.audio !== a) return;
			this.buffering = true;
			if (this.playRequested && a.readyState >= HAVE_FUTURE_DATA) this.play();
		});
		a.addEventListener('playing', () => {
			if (this.audio !== a) return;
			this.playingSince = performance.now();
			// Starting to play is progress: a slow start (the clock still at the load
			// position) must not be taken for a stall the moment it finally plays.
			this.lastProgressAt = this.playingSince;
			this.buffering = false;
			this.errorSkips = 0;
			this.errorOriginIndex = -1;
			this.watchFrozen(a);
		});
		a.addEventListener('canplay', () => {
			if (this.audio !== a) return;
			this.buffering = false;
			if (this.playRequested && a.paused) this.play();
		});
		a.addEventListener('loadedmetadata', () => {
			if (this.audio !== a) return;
			if (this.pendingSeek) {
				a.currentTime = this.pendingSeek;
				this.pendingSeek = 0;
			}
			this.applyDuration();
		});
		a.addEventListener('durationchange', () => {
			if (this.audio === a) this.applyDuration();
		});
		a.addEventListener('timeupdate', () => {
			if (this.audio === a) this.onTime();
		});
		a.addEventListener('ended', () => {
			if (this.audio === a) this.onEnded();
		});
		a.addEventListener('error', () => {
			if (this.audio === a) this.onError();
		});
		for (const type of LOGGED_EVENTS) {
			a.addEventListener(type, () => {
				if (this.audio === a) {
					logPlayback(type, `t=${a.currentTime.toFixed(1)} rs=${a.readyState} ns=${a.networkState} paused=${a.paused} vol=${a.volume} muted=${a.muted}`);
				}
			});
		}
		a.addEventListener('volumechange', () => {
			// Web Audio: the element stays at full volume; the graph's gain is the volume.
			if (this.audio !== a || this.output) return;
			this.volume = a.volume;
			this.muted = a.muted;
		});
	}

	/** Rebind platform playback integrations whenever the active audio changes. */
	private bindActiveAudio(a: HTMLAudioElement) {
		this.interruptions.setAudio(a);
		this.stopRemoteWatch();
		this.stopRemoteWatch = watchRemotePlayback(a, {
			availability: (available) => (this.castAvailable = available),
			state: (state, stalled) => {
				this.castState = state;
				this.castStalled = stalled;
			}
		});
		setupMediaSession(a, {
			play: () => this.resume(),
			pause: () => this.pause(),
			previous: () => this.previous(),
			next: () => this.next(),
			seek: (seconds) => this.seek(seconds),
			currentTime: () => this.time
		});
	}

	// ---- queue control -------------------------------------------------------

	playList(songs: Song[], start = 0, opts: { shuffle?: boolean } = {}) {
		if (!songs.length) return;
		const order = planPlayOrder(songs, start, this.shuffle, !!opts.shuffle);
		this.shuffle = order.shuffle;
		this.unshuffled = order.unshuffled;
		this.queue = order.queue;
		this.load(order.start, true);
	}

	playNext(songs: Song[]) {
		if (!this.current) return this.playList(songs);
		this.queue.splice(this.index + 1, 0, ...songs);
		this.unshuffled?.push(...songs);
		this.persist();
	}

	addToQueue(songs: Song[]) {
		if (!this.current) return this.playList(songs);
		this.queue.push(...songs);
		this.unshuffled?.push(...songs);
		this.persist();
	}

	/** Spread songs through the not-yet-played part of the queue (Smart Discover). */
	interleaveUpNext(songs: Song[], limit?: number) {
		if (!songs.length) return;
		if (!this.current) return this.playList(songs);
		const start = this.index + 1;

		let targetSection: Song[];
		let restSection: Song[];
		if (limit) {
			targetSection = this.queue.slice(start, start + limit);
			restSection = this.queue.slice(start + limit);
		} else {
			targetSection = this.queue.slice(start);
			restSection = [];
		}

		this.queue = [
			...this.queue.slice(0, start),
			...interleaveEvenly(targetSection, songs),
			...restSection
		];
		this.unshuffled?.push(...songs);
		this.persist();
	}

	removeAt(i: number) {
		const index = removeAt(this.queue, this.index, i);
		if (index === null) return;
		this.index = index;
		this.persist();
	}

	clearUpNext(keepCount = 0) {
		if (this.index + 1 + keepCount >= this.queue.length) return;
		this.queue.splice(this.index + 1 + keepCount);
		this.persist();
	}

	moveUpNext(from: number, to: number) {
		this.index = moveItem(this.queue, this.index, from, to);
		this.persist();
	}

	jumpTo(i: number) {
		this.load(i, true);
	}

	// ---- transport -----------------------------------------------------------

	toggle() {
		if (!this.current) return;
		if (this.playRequested) this.pause();
		else this.resume();
	}

	resume() {
		if (!this.current) return;
		// A source that errored can't just be played again; reload it. This is also
		// how the user restarts playback after the player gave up on a dead server.
		if (!this.audio.src || this.audio.error) {
			this.errorRetriedFor = null;
			this.errorSkips = 0;
			this.load(this.index, true, this.time);
		} else this.play();
	}

	pause() {
		logPlayback('pause-request');
		this.playRequested = false;
		this.resumeWhenVisible = false;
		this.buffering = false;
		this.interruptions.userPause();
		this.cancelPreroll();
		if (this.retiring) this.finishRetire(this.retiring.el);
		this.audio.pause();
	}

	next() {
		const i = nextIndex(this.queue.length, this.index, this.repeat);
		if (i >= 0) this.load(i, true);
		else {
			this.pause();
			this.seek(0);
		}
	}

	previous() {
		// Like every music app: restart the song unless we're within the first 3 seconds.
		if (this.audio.currentTime > 3 || this.index <= 0) this.seek(0);
		else this.load(this.index - 1, true);
	}

	seek(seconds: number) {
		// Back from the last seconds: the next song isn't due yet (onTime starts it again).
		this.cancelPreroll();
		this.setTime(seconds);
		if (this.audio.src) this.audio.currentTime = seconds;
		else this.pendingSeek = seconds;
		this.updatePosition();
	}

	setVolume(v: number) {
		if (this.output) {
			this.volume = Math.max(0, Math.min(1, v));
			if (v > 0) this.muted = false;
			this.output.setVolume(this.volume, this.muted);
			return;
		}
		this.audio.volume = Math.max(0, Math.min(1, v));
		if (v > 0) this.audio.muted = false;
	}

	toggleMute() {
		if (this.output) {
			this.muted = !this.muted;
			this.output.setVolume(this.volume, this.muted);
			return;
		}
		this.audio.muted = !this.audio.muted;
	}

	/** Sound goes through Web Audio: volume works on iOS and the equalizer applies. */
	get webAudio() {
		return this.output !== null;
	}

	/** Volume onto a newly active element: its own, or (Web Audio) the graph's. */
	private applyVolume(el: HTMLAudioElement) {
		if (this.output) {
			el.volume = 1;
			el.muted = false;
			this.output.setVolume(this.volume, this.muted);
			return;
		}
		el.volume = this.volume;
		el.muted = this.muted;
	}

	/** A document-attached element, joined to the Web Audio graph when that engine is on. */
	private newElement(): HTMLAudioElement {
		const el = createManagedAudio();
		if (this.output) {
			// Without CORS a cross-origin stream reaches the graph as silence.
			el.crossOrigin = 'anonymous';
			this.output.attach(el);
		}
		return el;
	}

	toggleShuffle() {
		const cur = this.current;
		if (!this.shuffle) {
			this.shuffle = true;
			this.unshuffled = [...this.queue];
			if (cur) {
				const order = shuffleAround(this.queue, this.index);
				this.queue = order.queue;
				this.index = order.index;
			}
		} else {
			this.shuffle = false;
			if (this.unshuffled) {
				this.queue = this.unshuffled;
				this.index = indexAfterUnshuffle(this.queue, cur);
			}
			this.unshuffled = null;
		}
		this.applyReplayGain(true);
		this.persist();
	}

	/**
	 * Karaoke on: find the playing song's karaoke version on YouTube and play it in the
	 * song's place, from the same moment. Off: back to the original. Returns why it
	 * couldn't start, or null.
	 */
	async toggleKaraoke(): Promise<string | null> {
		if (this.karaoke) {
			const { original } = this.karaoke;
			this.leaveKaraoke();
			this.replaceCurrent(original);
			return null;
		}
		const song = this.current;
		if (!song || this.karaokeLoading) return null;
		this.karaokeLoading = true;
		let found: Song | null = null;
		try {
			found = await getKaraoke(song);
		} catch (e) {
			logPlayback('karaoke-failed', String(e));
		}
		this.karaokeLoading = false;
		if (this.current?.id !== song.id) return null; // moved on while searching
		if (!found) return 'No karaoke version found for this song.';
		const version: Song = { ...found, coverArt: song.coverArt ?? found.coverArt, karaokeOf: song.id };
		logPlayback('karaoke', `id=${song.id} → ${version.id}`);
		this.karaoke = { original: $state.snapshot(song) as Song, version };
		this.replaceCurrent(version);
		return null;
	}

	/** Ends karaoke, putting the original back wherever its karaoke version sits. */
	private leaveKaraoke() {
		const k = this.karaoke;
		if (!k) return;
		this.karaoke = null;
		const swap = (list: Song[]) => list.map((s) => (s.id === k.version.id ? k.original : s));
		this.queue = swap(this.queue);
		if (this.unshuffled) this.unshuffled = swap(this.unshuffled);
	}

	/** Plays `song` in the current song's place, from the same moment. */
	private replaceCurrent(song: Song) {
		const from = this.current;
		if (!from) return;
		const queue = [...this.queue];
		queue[this.index] = song;
		this.queue = queue;
		if (this.unshuffled) this.unshuffled = this.unshuffled.map((s) => (s.id === from.id ? song : s));
		const at = song.duration && this.time > song.duration - 5 ? 0 : this.time;
		void this.load(this.index, this.playRequested || this.playing, at);
	}

	cycleRepeat() {
		this.repeat = cycleRepeat(this.repeat);
		this.persist();
	}

	/** Opens the system device picker; false when this browser has none. */
	pickOutput(): Promise<boolean> {
		return pickOutput(this.audio);
	}

	// ---- track changes -------------------------------------------------------

	/**
	 * Start track `i`, from a downloaded/prefetched copy when there is one.
	 *
	 * Everything up to the first `await` runs synchronously. When the track is
	 * `playingOffline`, `nextReady`, or known to have no offline copy, there is no
	 * await at all, which is what lets a track change from `ended` work on a hidden page.
	 */
	private async load(i: number, autoplay: boolean, startAt = 0) {
		// Karaoke is per song: moving to another puts the original back in the queue.
		if (this.karaoke && this.queue[i]?.id !== this.karaoke.version.id) this.leaveKaraoke();
		const song = this.queue[i];
		if (!song) return;
		// A preroll only carries on into the song it was started for, from its start.
		if (this.preroll && (song.id !== this.upcoming()?.id || !autoplay || startAt !== 0)) this.cancelPreroll();
		// A handoff still finishing ends with the next change.
		if (this.retiring) this.finishRetire(this.retiring.el);
		const token = ++this.loadToken;
		this.index = i;
		this.standbyStreamId = null;
		// A whole-track download for a song that is no longer next (most often the one
		// starting now, which will stream instead) would only compete with the stream.
		if (this.blobJob && this.blobJob.id !== this.upcoming()?.id) {
			logPlayback('blob-cancel', `id=${this.blobJob.id}`);
			this.blobJob.abort.abort();
			this.blobJob = null;
		}
		this.error = null;
		this.scrobbled = false;
		this.durationCap = 0;
		this.setTime(startAt);
		this.duration = song.duration ?? 0;
		this.pendingSeek = startAt;
		this.lastProgressAt = performance.now();
		this.lastProgressTime = -1;
		this.lastPositionSlot = -1;
		this.playing = false;
		this.playRequested = autoplay;
		this.buffering = autoplay;
		if (autoplay) this.armStallCheck();
		// Publish the next track before any IndexedDB lookup or stream setup.
		// Those awaits may be suspended by iOS in the background; leaving the
		// previous metadata active makes the lock screen show the wrong song and
		// duration even after the queue has advanced.
		setMediaMetadata(song);
		setMediaPosition(this.duration, startAt, this.audio.playbackRate);

		let offline: OfflineCopy | null = null;
		if (this.playingOffline?.id === song.id) {
			// Restarting the same track: keep its URL.
			offline = this.playingOffline;
			this.playingOffline = null;
		} else if (this.nextReady?.id === song.id) {
			offline = this.nextReady;
			this.nextReady = null;
		} else if (this.offlineMissFor === song.id) {
			// prepareNextOffline already checked IndexedDB: no copy. Don't await again.
			this.offlineMissFor = null;
		} else {
			// IndexedDB is local and safe to read in the background. If there is no
			// explicitly downloaded copy, native <audio> remains the fallback.
			const copy = await lookupOffline(song.id);
			// The user moved on to another track while we were looking.
			if (this.destroyed || token !== this.loadToken) {
				copy?.revoke();
				return;
			}
			if (copy) offline = { id: song.id, copy };
		}
		const outgoing = this.playingOffline;
		this.playingOffline = offline;
		const src = offline?.copy.url ?? streamUrl(song.id);
		const handoff = autoplay && startAt === 0 && this.standbyHolds(src);

		logPlayback(
			'load',
			`id=${song.id} "${song.title}" at=${startAt.toFixed(1)} ${offline ? 'ready (offline/prefetched)' : 'stream'}${handoff ? ' handoff' : ''}`
		);
		if (handoff) {
			// The outgoing copy stays valid while its element finishes; it is revoked on retire.
			this.swapToStandby(outgoing);
		} else {
			// Not taking over the prerolled element after all: stop it, or both would play.
			this.cancelPreroll();
			outgoing?.copy.revoke();
			this.output?.resetFade(this.audio);
			this.audio.autoplay = autoplay;
			this.applyVolume(this.audio);
			this.audio.src = src;
			this.audio.load();
			if (startAt > 0) this.audio.currentTime = startAt;
		}
		this.output?.trackChanged(isLossless(song));
		this.applyReplayGain();
		// The standby copy was either just promoted or no longer matches `nextReady`.
		this.primeStandby();
		if (autoplay) {
			// Unlike Navidrome, play() right away rather than waiting for `canplay`: a cold
			// YouTube track takes seconds to arrive, and Android/iOS refuse to start audio
			// from a background page that has been silent that long. `canplay` still retries.
			this.play();
			if (!song.karaokeOf) scrobble(song.id, false);
		}
		this.persist();
		this.prepareNextOffline();
	}

	/** The track `next()` would load when the current one ends. */
	private upcoming(): Song | undefined {
		return this.queue[this.index + 1] ?? (this.repeat === 'all' ? this.queue[0] : undefined);
	}

	/**
	 * Whether the standby element is used: always off iOS (see the class comment). On
	 * iOS only to crossfade, and only while the app is on screen: in the background iOS
	 * keeps to the single element that got the user's tap.
	 */
	private standbyAllowed(): boolean {
		return !this.ios || !!this.preroll || (this.crossfadeFor(Infinity) > 0 && !document.hidden);
	}

	/** Seconds to crossfade a song of `dur` seconds into the next one; 0 to cut. */
	private crossfadeFor(dur: number): number {
		// An end-of-track sleep timer stops at the very end, so no early handoff.
		if (!this.output || !audioSettings.crossfade || sleepTimer.isEndOfTrack) return 0;
		return dur >= CROSSFADE_S * 3 ? CROSSFADE_S : 0;
	}

	/** Sound Check: the playing song's ReplayGain onto its element (unity when off). */
	private applyReplayGain(smooth = false) {
		if (!this.output) return;
		const song = this.current;
		const gain = this.replayGainAt(this.index);
		this.output.setTrim(this.audio, gain, smooth);
		if (audioSettings.soundCheck && !smooth) logPlayback('replaygain', `id=${song?.id} ${(20 * Math.log10(gain)).toFixed(1)} dB`);
	}

	/** Sound Check gain for the song at `index` (unity when off). */
	private replayGainAt(index: number): number {
		if (!audioSettings.soundCheck) return 1;
		return replayGainFactor(this.queue[index], gainModeFor(this.queue, index, this.shuffle));
	}

	/**
	 * Crossfade: start the next song on the standby element, silent until it is
	 * actually playing, then fading in under this song's last `remaining` seconds
	 * while this one fades out. The switch itself (title, queue, lyrics, lock screen)
	 * still waits for this song's `ended`, so what's shown is the song ending; by then
	 * the next one is already playing and simply takes over (`swapToStandby`).
	 */
	private startPreroll(remaining: number) {
		const el = this.standby;
		const output = this.output;
		if (!el || !output) return;
		const nextIndex = this.queue[this.index + 1] ? this.index + 1 : 0;
		const endsAt = performance.now() + remaining * 1000;
		const preroll = { el, listeners: new AbortController(), fading: false };
		this.preroll = preroll;
		output.silenceFade(el);
		output.setTrim(el, this.replayGainAt(nextIndex));
		// Not before it plays: a slow start would otherwise use up the fade, leaving
		// this song faded out and the next one jumping in near full.
		el.addEventListener(
			'playing',
			() => {
				const seconds = Math.max(0.5, (endsAt - performance.now()) / 1000);
				preroll.fading = true;
				logPlayback('crossfade', `${seconds.toFixed(1)}s`);
				output.crossfade(this.audio, el, seconds);
			},
			{ once: true, signal: preroll.listeners.signal }
		);
		logPlayback('preroll', `id=${this.queue[nextIndex]?.id} ${remaining.toFixed(1)}s left`);
		el.play().catch((e: unknown) => {
			logPlayback('preroll-rejected', String(e));
			if (this.preroll === preroll) this.cancelPreroll();
		});
	}

	/** Stops a preroll that won't become the next song after all (pause, seek, skip, queue change). */
	private cancelPreroll() {
		const preroll = this.preroll;
		if (!preroll) return;
		this.preroll = null;
		preroll.listeners.abort();
		preroll.el.pause();
		try {
			preroll.el.currentTime = 0;
		} catch {
			/* nothing loaded yet */
		}
		this.output?.resetFade(preroll.el);
		this.output?.resetFade(this.audio);
		logPlayback('preroll-cancel');
	}

	/** The standby element has `url` loaded and can take over playback now. */
	private standbyHolds(url: string): boolean {
		return (
			!!this.standby &&
			this.standbyFor === url &&
			!this.retiring &&
			this.standbyAllowed() &&
			// Casting follows the element that started it; a swap would drop the session.
			this.castState === 'disconnected'
		);
	}

	/**
	 * What the standby element should hold for the upcoming track: its downloaded copy
	 * when there is one, else its stream once `standbyStreamId` asks for it.
	 */
	private standbySource(): { id: string; url: string; kind: 'copy' | 'stream' } | null {
		const next = this.upcoming();
		if (!next || next.id === this.current?.id) return null;
		if (this.nextReady?.id === next.id) return { id: next.id, url: this.nextReady.copy.url, kind: 'copy' };
		if (this.standbyStreamId === next.id) return { id: next.id, url: streamUrl(next.id), kind: 'stream' };
		return null;
	}

	/**
	 * Non-iOS: load the next track into the standby element, paused, so the handoff
	 * needs no fresh element (and, for a downloaded copy, no network). Clears it when the
	 * next track changes. Waits while a handoff is still finishing on that element.
	 */
	private primeStandby() {
		if (!this.standbyAllowed() || this.retiring || this.destroyed) return;
		const source = this.standbySource();
		const url = source?.url ?? null;
		if (url === this.standbyFor) return;
		// The next song changed (queue edit) while it was prerolling.
		this.cancelPreroll();
		this.standbyFor = url;
		if (!source) {
			if (this.standby?.getAttribute('src')) {
				this.standby.removeAttribute('src');
				this.standby.load();
			}
			return;
		}
		if (!this.standby) {
			this.standby = this.newElement();
			this.bindElement(this.standby);
		}
		this.standby.autoplay = false;
		this.standby.preload = 'auto';
		this.standby.src = source.url;
		this.standby.load();
		logPlayback('standby-ready', `id=${source.id} ${source.kind}`);
	}

	/**
	 * Non-iOS, near the end of a track whose successor isn't downloaded: put the
	 * successor's stream on standby, and drop the download, which would now only compete
	 * with both streams for bandwidth.
	 */
	private standbyNextStream() {
		const next = this.upcoming();
		if (!this.standbyAllowed() || !next || next.id === this.current?.id) return;
		if (this.nextReady?.id === next.id || this.standbyStreamId === next.id) return;
		this.standbyStreamId = next.id;
		if (this.blobJob?.id === next.id) {
			logPlayback('blob-cancel', `id=${next.id} streaming on standby instead`);
			this.blobJob.abort.abort();
			this.blobJob = null;
		}
		this.primeStandby();
	}

	/**
	 * Make the standby element (already holding the track being loaded) the active one.
	 * The old element is left to play its last moments and is only stopped once the new
	 * one is playing, so there is never a moment without a playing element. After a
	 * crossfade preroll the new one is already playing and the old one has ended.
	 */
	private swapToStandby(outgoing: OfflineCopy | null) {
		const old = this.audio;
		const next = this.standby!;
		this.audio = next;
		this.standby = old;
		this.standbyFor = null;
		this.bindActiveAudio(next);
		this.applyVolume(next);
		const preroll = this.preroll;
		if (preroll) {
			this.preroll = null;
			preroll.listeners.abort();
			// It never got to play under the old song, or a skip cut the fade short:
			// full level now.
			if (!preroll.fading || !old.ended) this.output?.resetFade(next);
			old.autoplay = false;
			old.pause();
			old.removeAttribute('src');
			old.load();
			this.output?.resetFade(old);
			outgoing?.copy.revoke();
			return;
		}
		// Whichever fires first finishes the handoff; the abort then removes the other,
		// which `once` alone would leave attached for good (one per track change).
		const listeners = new AbortController();
		this.retiring = { el: old, copy: outgoing, listeners };
		const finish = () => this.finishRetire(old);
		old.addEventListener('ended', finish, { once: true, signal: listeners.signal });
		this.output?.resetFade(next);
		next.addEventListener('playing', finish, { once: true, signal: listeners.signal });
	}

	private finishRetire(old: HTMLAudioElement) {
		const retiring = this.retiring;
		if (!retiring || retiring.el !== old) return;
		this.retiring = null;
		retiring.listeners.abort();
		old.autoplay = false;
		old.pause();
		old.removeAttribute('src');
		old.load();
		retiring.copy?.copy.revoke();
		this.primeStandby();
	}

	private prepareNextOffline() {
		const next = this.upcoming();
		if (!next || next.id === this.current?.id || this.nextReady?.id === next.id) return;
		void lookupOffline(next.id).then((copy) => {
			if (this.destroyed || this.upcoming()?.id !== next.id) {
				copy?.revoke();
				return;
			}
			if (!copy) {
				this.offlineMissFor = next.id;
				// No downloaded copy: the server will have to resolve it. Start that now,
				// while the current track is still playing and the page is not suspended.
				void this.warmNext();
				return;
			}
			if (this.nextReady?.id === next.id) {
				copy.revoke();
				return;
			}
			this.nextReady?.copy.revoke();
			this.nextReady = { id: next.id, copy };
			this.primeStandby();
		});
	}

	/**
	 * Ask the server for two bytes of the next track as soon as the current one starts.
	 * A cold YouTube track can take over a minute to resolve on the server; doing it here,
	 * while audio is playing and the page is still running, means the later whole-track
	 * download or stream request is answered from the server's cache. Deliberately not
	 * aborted on track change or by `load()`: finishing the resolve is the whole point.
	 */
	private async warmNext() {
		const next = this.upcoming();
		if (!next || next.id === this.current?.id) return;
		if (this.nextReady?.id === next.id || this.warmed.has(next.id)) return;
		this.warmed.add(next.id);
		const started = performance.now();
		logPlayback('warm-start', `id=${next.id}`);
		try {
			const res = await fetch(streamUrl(next.id), { headers: { Range: 'bytes=0-1' }, cache: 'no-store' });
			if (res.ok) void res.body?.cancel();
			logPlayback('warm-done', `id=${next.id} status=${res.status} ${Math.round(performance.now() - started)}ms`);
			// A non-2xx answer did not resolve anything: allow another attempt.
			if (!res.ok) this.warmed.delete(next.id);
		} catch (e) {
			// Allow a later retry (e.g. a proxy timeout cut the request short).
			this.warmed.delete(next.id);
			logPlayback('warm-failed', `id=${next.id} ${Math.round(performance.now() - started)}ms ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	/**
	 * Download the whole next track into memory while the current one still plays,
	 * so the `ended` handler can start it with no await and no network.
	 *
	 * Failures are retried a few times, spaced out, because the lead is long enough
	 * for a flaky or slow server to recover before the track ends.
	 */
	private async prefetchNextBlob() {
		const next = this.upcoming();
		if (!next || next.id === this.current?.id) return;
		// Already streaming into the standby element: a download would only compete with it.
		if (this.standbyStreamId === next.id) return;
		// A copy for a track that is no longer next (the queue changed) is dead weight.
		if (this.nextReady && this.nextReady.id !== next.id) {
			this.nextReady.copy.revoke();
			this.nextReady = null;
			this.primeStandby();
		}
		if (this.nextReady?.id === next.id || this.blobJob?.id === next.id) return;

		const failure = this.blobFailure?.id === next.id ? this.blobFailure : null;
		if (
			failure &&
			(failure.final ||
				failure.count >= MAX_BLOB_ATTEMPTS ||
				performance.now() - failure.at < BLOB_RETRY_GAP_MS)
		) {
			return;
		}

		this.blobJob?.abort.abort();
		const job: BlobJob = { id: next.id, abort: new AbortController(), timedOut: false };
		this.blobJob = job;
		const timeout = setTimeout(() => {
			job.timedOut = true;
			job.abort.abort();
		}, BLOB_FETCH_TIMEOUT_MS);
		const attempt = (failure?.count ?? 0) + 1;
		logPlayback('blob-start', `id=${next.id} "${next.title}" attempt=${attempt}`);
		try {
			const res = await fetch(streamUrl(next.id), { signal: job.abort.signal });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const length = Number(res.headers.get('content-length') ?? 0);
			if (length > MAX_BLOB_BYTES) {
				void res.body?.cancel();
				this.blobFailure = { id: next.id, count: attempt, at: performance.now(), final: true };
				logPlayback('blob-skipped', `id=${next.id} too large (${length} bytes), will stream`);
				return;
			}
			const blob = await res.blob();
			if (this.destroyed || this.upcoming()?.id !== next.id) return;
			if (blob.size < MIN_BLOB_BYTES) throw new Error(`too small (${blob.size} bytes)`);
			// An offline copy could have landed while we downloaded.
			if (this.nextReady?.id === next.id) return;
			const url = URL.createObjectURL(blob);
			this.nextReady?.copy.revoke();
			this.nextReady = { id: next.id, copy: { url, revoke: () => URL.revokeObjectURL(url) } };
			this.primeStandby();
			this.blobFailure = null;
			logPlayback('blob-ready', `id=${next.id} bytes=${blob.size} type=${blob.type}`);
		} catch (e) {
			// Superseded by a newer job or by unload(): not a failure.
			if (job.abort.signal.aborted && !job.timedOut) return;
			this.blobFailure = { id: next.id, count: attempt, at: performance.now(), final: false };
			logPlayback(
				'blob-failed',
				`id=${next.id} attempt=${attempt} ${job.timedOut ? 'timeout' : e instanceof Error ? e.message : String(e)}`
			);
		} finally {
			clearTimeout(timeout);
			if (this.blobJob === job) this.blobJob = null;
		}
	}

	private play() {
		this.playRequested = true;
		this.output?.resume();
		this.armStallCheck();
		const token = this.loadToken;
		this.audio.play().then(() => {
			// A resolved promise means playback was accepted; reflect that immediately
			// in the controls even if no new canplay/playing event follows.
			if (token === this.loadToken && !this.audio.paused) {
				this.playing = true;
				this.buffering = false;
			}
		}).catch((e: unknown) => {
			logPlayback('play-rejected', e instanceof DOMException ? `${e.name}: ${e.message}` : String(e));
			// A track change interrupted this play(); the new source's `canplay` owns it now.
			if (token !== this.loadToken) return;
			// The source itself is unplayable: that is a track error, not a refused
			// autoplay. Send it through the retry/skip flow so a queue left playing with
			// the screen off keeps going.
			if (e instanceof DOMException && e.name === 'NotSupportedError') {
				this.onError();
				return;
			}
			// Refused (e.g. autoplay blocked): show it as paused rather than playing in silence.
			this.playRequested = false;
			this.playing = false;
			this.buffering = false;
			if (document.hidden) this.resumeWhenVisible = true;
		});
	}

	/** iOS may end another app's audio interruption while this page is hidden. */
	private resumeAfterInterruption() {
		if (document.hidden) {
			this.resumeWhenVisible = true;
			return;
		}
		this.play();
	}

	private readonly onVisibilityChange = () => {
		logPlayback('visibility', document.visibilityState);
		if (document.hidden) {
			// Invalidate the watchdog now, including a callback iOS may hold and release
			// on the next foreground.
			this.disarmStallCheck();
			return;
		}
		this.currentTime = this.time; // the UI copy was frozen while hidden
		if (!this.current) return;
		// "Playing" but no progress for a while (timeupdates keep `lastProgressAt` fresh
		// while hidden too): frozen, typically since a call. play() wouldn't change that.
		if (
			!this.audio.paused &&
			this.audio.readyState >= HAVE_FUTURE_DATA &&
			performance.now() - this.lastProgressAt > FROZEN_MS
		) {
			logPlayback('frozen', `t=${this.time.toFixed(1)} on visible`);
			this.resumeWhenVisible = false;
			this.recoverFrozen();
			return;
		}
		// Background time is not stalled time: the 15 s window starts now. (The play()
		// or load() below arms the watchdog again.)
		this.lastProgressAt = performance.now();
		// play() rejected in the background clears playRequested but sets
		// resumeWhenVisible, so both count as "playback was wanted".
		if (!this.playRequested && !this.resumeWhenVisible) return;
		this.playRequested = true;
		this.resumeWhenVisible = false;
		// A source that failed while the network was cut can't just be played again.
		if (this.audio.error || !this.audio.src) {
			this.errorRetriedFor = null;
			this.errorSkips = 0;
			this.load(this.index, true, this.time);
		} else this.play();
	};

	/**
	 * Checks, a moment after `playing`, that the clock actually moves. After a call iOS
	 * can resume the element into "playing" with no sound and a frozen clock, and the
	 * stall watchdog is off in the background, so nothing else notices. Visible: reload
	 * it where it was. Hidden: a reload there is refused, so `onVisibilityChange` does it.
	 */
	private watchFrozen(a: HTMLAudioElement) {
		const from = a.currentTime;
		const token = this.loadToken;
		setTimeout(() => {
			if (this.audio !== a || token !== this.loadToken || a.paused || a.currentTime !== from) return;
			// Still waiting for data: the stall watchdog's case, not this one.
			if (a.readyState < HAVE_FUTURE_DATA) return;
			logPlayback('frozen', `t=${from.toFixed(1)}`);
			if (document.hidden) this.resumeWhenVisible = true;
			else this.recoverFrozen();
		}, FROZEN_MS);
	}

	/** Reloads the current song where it froze and plays it. */
	private recoverFrozen() {
		this.errorRetriedFor = null;
		this.errorSkips = 0;
		void this.load(this.index, true, this.time);
	}

	/** Current playback position, even while the page is hidden. */
	get position() {
		return this.time;
	}

	private setTime(seconds: number) {
		this.time = seconds;
		this.currentTime = seconds;
	}

	private onTime() {
		const a = this.audio;
		this.time = a.currentTime;
		if (!document.hidden) this.currentTime = this.time;
		const song = this.current;
		const dur = this.duration || song?.duration || 0;
		// Last.fm rule: scrobble after half the track or 4 minutes, whichever first.
		if (song && !this.scrobbled && dur > 30 && (a.currentTime >= dur / 2 || a.currentTime >= 240)) {
			this.scrobbled = true;
			// Singing along isn't listening to the song: karaoke versions aren't scrobbled.
			if (!song.karaokeOf) scrobble(song.id, true);
		}
		if (a.currentTime !== this.lastProgressTime) {
			this.lastProgressTime = a.currentTime;
			this.lastProgressAt = performance.now();
		}
		// It has played for a while: a later failure is a new incident and gets its own retry.
		if (a.currentTime > ERROR_REARM_AFTER_S) this.errorRetriedFor = null;
		// Resync the lock-screen position once per 5 s slot. (A `% 5` check stays true
		// for a whole second, i.e. ~4 timeupdates, each a round trip to the OS.)
		const slot = Math.floor(a.currentTime / 5);
		if (slot !== this.lastPositionSlot) {
			this.lastPositionSlot = slot;
			this.updatePosition();
		}
		const upcoming = this.upcoming();
		if (dur > 0 && upcoming && dur - a.currentTime <= blobLeadFor(upcoming.id)) void this.prefetchNextBlob();
		// The real audio is over; don't sit through the silence up to the misread length.
		// Switch straight to the next track without pausing: on a hidden iOS page a pause
		// ends the audio session, and the next track then never gets past its metadata.
		// load() clears durationCap synchronously, so this can't fire twice.
		if (this.durationCap && !a.paused && a.currentTime >= this.durationCap - 0.25) {
			logPlayback('capped-end', `cap=${this.durationCap} media=${a.duration}`);
			this.onEnded();
			return;
		}
		if (dur <= 0 || a.paused || this.repeat === 'one') return;
		const remaining = dur - a.currentTime;
		if (remaining <= STREAM_STANDBY_LEAD_S) this.standbyNextStream();
		const source = this.standbySource();
		const ready = !!source && this.standbyHolds(source.url);
		// Crossfade: start the next song under this one's last seconds. The switch to it
		// waits for `ended`, which also keeps some element playing throughout.
		const fade = this.crossfadeFor(dur);
		if (fade && ready && !this.preroll && remaining <= fade) this.startPreroll(remaining);
		// Otherwise hand over to the standby element just before the end, while this
		// one still plays.
		if (!this.preroll && ready && remaining <= HANDOFF_LEAD_S) {
			logPlayback(
				'handoff-early',
				`t=${a.currentTime.toFixed(2)} dur=${dur.toFixed(2)} ${source!.kind} standby rs=${this.standby?.readyState}`
			);
			this.onEnded();
		}
	}

	private applyDuration() {
		const d = this.audio.duration;
		if (!Number.isFinite(d) || d <= 0) return;
		const reported = this.current?.duration ?? 0;
		if (reported > 0 && d > reported * DURATION_MISMATCH_RATIO) {
			this.duration = reported;
			this.durationCap = reported;
		} else {
			this.duration = d;
			this.durationCap = 0;
		}
	}

	// ---- stalled streams -----------------------------------------------------
	// A stream that stops delivering (network drop, Wi-Fi/4G switch, a load that never
	// reaches `canplay`) leaves playback wanted but the clock frozen; only a fresh
	// request at the current position recovers it.

	// A self-rescheduling timeout, not a fixed 2 s interval: while playback is
	// progressing it only wakes about once per STALL_TIMEOUT_MS (instead of ~30
	// times a minute for the whole session, screen off included). `onTime` keeps
	// `lastProgressAt` fresh, so nothing has to be re-armed per timeupdate.
	//
	// The watchdog never runs while the page is hidden: it can't recover anything there
	// (reloading a stream in the background aborts play() with an AbortError), and iOS
	// may hold its timer and release it the instant the page is shown again, when "no
	// progress for 15 s" is just the background time. It is disarmed on `hidden` and
	// re-armed (with a fresh progress clock) when playback is resumed on `visible`.
	private armStallCheck() {
		this.lastProgressAt = performance.now();
		if (document.hidden) return;
		if (this.stallTimer === undefined) this.scheduleStallCheck(STALL_TIMEOUT_MS);
	}

	private scheduleStallCheck(ms: number) {
		const delay = Math.max(STALL_CHECK_MS, ms);
		const gen = this.stallGen;
		this.stallDueAt = performance.now() + delay;
		this.stallTimer = setTimeout(() => this.checkStall(gen), delay);
	}

	private disarmStallCheck() {
		clearTimeout(this.stallTimer);
		this.stallTimer = undefined;
		// Void a callback the browser may already have queued (clearTimeout can't recall it).
		this.stallGen++;
	}

	private readonly checkStall = (gen: number) => {
		if (gen !== this.stallGen) return;
		this.stallTimer = undefined;
		if (!this.playRequested || !this.current) return;
		// Belt and braces: armed while visible but the page was hidden since.
		if (document.hidden) {
			this.resumeWhenVisible = true;
			return;
		}
		// Held by the OS and released late: no information about real progress. Start a
		// fresh window instead of treating the held time as a stall.
		const late = performance.now() - this.stallDueAt;
		if (late > STALL_LATE_MS) {
			logPlayback('stall-check-late', `${Math.round(late)}ms, ignored`);
			this.lastProgressAt = performance.now();
			return this.scheduleStallCheck(STALL_TIMEOUT_MS);
		}
		// Paused by the system (a call) rather than stuck loading: not a stall.
		// Keep the old 2 s cadence so a stall right after it resumes is still caught.
		if (this.audio.paused && !this.buffering) return this.scheduleStallCheck(STALL_CHECK_MS);
		const quiet = performance.now() - this.lastProgressAt;
		// Still progressing: check again when the timeout could next be reached.
		if (quiet < STALL_TIMEOUT_MS) return this.scheduleStallCheck(STALL_TIMEOUT_MS - quiet);
		// Stop the dead request and let the higher-level error flow retry once,
		// then fallback or skip the track.
		// Still loading as far as the request goes: the `pause` handler keeps
		// playRequested while buffering, so the retry below isn't cancelled.
		this.buffering = true;
		this.audio.pause();
		logPlayback('stall-timeout', `t=${this.time.toFixed(1)} rs=${this.audio.readyState}`);
		this.onError();
	};

	/**
	 * The source failed (often the server couldn't resolve a YouTube track). Reload it
	 * once, then skip to the next track so a queue left playing with the screen off
	 * keeps going. Every step waits a moment, and if several different tracks fail in
	 * a row the player gives up on the first failed one instead of cycling the queue.
	 */
	private onError() {
		const a = this.audio;
		const song = this.current;
		if (!a.src || !song) return;
		// One failure can arrive as an `error` event, a rejected play() and a stall
		// timeout. Handle it once per load, or retry and skip would both fire.
		if (this.errorHandledToken === this.loadToken) return;
		this.errorHandledToken = this.loadToken;
		logPlayback('media-error', `id=${song.id} code=${a.error?.code} ${a.error?.message ?? ''}`);
		void this.probeSource(a.src);
		// A prefetched blob that fails to play is bad: forget it so the retry uses the stream.
		if (this.playingOffline?.id === song.id && this.playingOffline.copy.url === a.src) {
			this.releaseOffline();
		}
		if (this.playRequested && this.errorRetriedFor !== song.id) {
			this.errorRetriedFor = song.id;
			this.afterErrorDelay(() => this.load(this.index, true, this.time));
			return;
		}
		this.error = `Couldn't play “${song.title}”`;
		if (this.playRequested && this.upcoming() && this.errorSkips < MAX_ERROR_SKIPS) {
			if (this.errorSkips === 0) this.errorOriginIndex = this.index;
			this.errorSkips++;
			this.afterErrorDelay(() => this.next());
			return;
		}
		// Several different tracks failed in a row: that is the connection or the
		// session, not the tracks. Go back to the first failed track instead of
		// burning through the queue, and resume it when the app is visible again.
		if (this.errorOriginIndex >= 0 && this.errorOriginIndex !== this.index && this.queue[this.errorOriginIndex]) {
			this.index = this.errorOriginIndex;
			this.setTime(0);
			this.duration = this.current?.duration ?? 0;
			setMediaMetadata(this.current);
		}
		this.errorOriginIndex = -1;
		const wanted = this.playRequested;
		// A failed element can still report "not paused": stop it so the button shows play.
		this.pause();
		this.playing = false;
		// pause() clears the flag; set it afterwards so onVisibilityChange can recover.
		this.resumeWhenVisible = wanted;
	}

	/** Run a retry/skip after a short pause, unless the user moved on in the meantime. */
	private afterErrorDelay(fn: () => void) {
		clearTimeout(this.errorTimer);
		const token = this.loadToken;
		this.errorTimer = setTimeout(() => {
			if (this.destroyed || token !== this.loadToken || !this.playRequested) return;
			fn();
		}, ERROR_RETRY_DELAY_MS);
	}

	/**
	 * <audio> only says "Format error" for any HTTP failure. Ask the same URL for two
	 * bytes and log the status (and the start of an error body), so 401/403 (expired
	 * credential), 429 (rate limit) and 5xx (server) can be told apart in the log.
	 */
	private async probeSource(src: string) {
		if (src.startsWith('blob:')) return;
		const now = performance.now();
		if (now - this.lastProbeAt < PROBE_MIN_GAP_MS) return;
		this.lastProbeAt = now;
		try {
			const res = await fetch(src, { headers: { Range: 'bytes=0-1' }, cache: 'no-store' });
			let detail = '';
			if (res.ok) void res.body?.cancel();
			else detail = ` body=${(await res.text()).slice(0, 160).replace(/\s+/g, ' ')}`;
			logPlayback(
				'probe',
				`status=${res.status} type=${res.headers.get('content-type')} len=${res.headers.get('content-length')} range=${res.headers.get('content-range')}${detail}`
			);
		} catch (e) {
			logPlayback('probe-failed', e instanceof Error ? e.message : String(e));
		}
	}

	private onEnded() {
		if (this.repeat === 'one') {
			this.scrobbled = false;
			this.audio.currentTime = 0;
			this.play();
			return;
		}
		if (sleepTimer.onTrackEnded()) logPlayback('sleep-timer-stop');
		else this.next();
	}

	private updatePosition() {
		setMediaPosition(this.duration, this.time, this.audio.playbackRate);
	}

	private releaseOffline() {
		this.playingOffline?.copy.revoke();
		this.playingOffline = null;
	}

	/** Unload the element so it stops fetching and releases the stream. */
	private unload() {
		this.cancelPreroll();
		this.loadToken++;
		this.playRequested = false;
		this.resumeWhenVisible = false;
		this.buffering = false;
		this.audio.pause();
		this.audio.removeAttribute('src');
		this.audio.load();
		this.disarmStallCheck();
		clearTimeout(this.errorTimer);
		this.errorOriginIndex = -1;
		this.blobJob?.abort.abort();
		this.blobJob = null;
		this.blobFailure = null;
		this.warmed.clear();
		this.offlineMissFor = null;
		this.releaseOffline();
		this.nextReady?.copy.revoke();
		this.nextReady = null;
		this.retiring?.copy?.copy.revoke();
		this.retiring?.listeners.abort();
		this.retiring = null;
		this.standbyFor = null;
		this.standbyStreamId = null;
		if (this.standby) {
			this.standby.autoplay = false;
			this.standby.pause();
			this.standby.removeAttribute('src');
			this.standby.load();
		}
	}

	private readonly onPageHide = (e: PageTransitionEvent) => {
		logPlayback('pagehide', `persisted=${e.persisted}`);
		if (e.persisted) return;
		this.saveSnapshot();
		clearMediaSession();
	};

	// ---- persistence ---------------------------------------------------------

	private saveSnapshot() {
		writeSnapshot({
			queue: this.queue,
			index: this.index,
			time: this.time,
			shuffle: this.shuffle,
			repeat: this.repeat,
			unshuffled: this.unshuffled
		});
	}

	/** Local snapshot always; the server copy (cross-device resume) on pause and track change. */
	private persist(toServer = false) {
		// A replaced instance must never write over its successor's snapshot.
		if (this.destroyed) return;
		clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => this.saveSnapshot(), 300);
		if (toServer || !this.playing) {
			savePlayQueue(
				this.queue.map((s) => s.id),
				this.current?.id,
				Math.floor(this.time * 1000)
			);
		}
	}

	private async restore() {
		const saved = readSnapshot();
		if (saved) {
			this.queue = saved.queue;
			this.index = saved.index;
			this.setTime(saved.time);
			this.duration = this.current?.duration ?? 0;
			this.shuffle = saved.shuffle;
			this.repeat = saved.repeat;
			this.unshuffled = saved.unshuffled;
			setMediaMetadata(this.current);
			if (this.queue.length) return;
		}
		const remote = await getPlayQueue();
		if (remote && !this.queue.length) {
			this.queue = remote.songs;
			this.index = Math.max(0, remote.songs.findIndex((s) => s.id === remote.current));
			this.setTime(remote.position / 1000);
			this.duration = this.current?.duration ?? 0;
			setMediaMetadata(this.current);
		}
	}

	// ---- lifecycle -----------------------------------------------------------

	/** Stops and releases the audio element so it can never keep playing orphaned. */
	destroy() {
		this.saveSnapshot();
		this.destroyed = true;
		this.unload();
		this.singleTab.close();
		this.stopRemoteWatch();
		this.stopRemoteWatch = () => {};
		this.interruptions.dispose();
		this.stopDiagnostics();
		this.stopAudioSettings();
		this.stopDiagnostics = () => {};
		this.audio.remove();
		this.standby?.remove();
		this.output?.dispose();
		window.removeEventListener('pagehide', this.onPageHide);
		document.removeEventListener('visibilitychange', this.onVisibilityChange);
		clearTimeout(this.saveTimer);
	}

	/** Called on sign-out. */
	reset() {
		this.unload();
		this.queue = [];
		this.index = -1;
		this.setTime(0);
		this.duration = 0;
		this.error = null;
		this.buffering = false;
		this.unshuffled = null;
		clearSnapshot();
	}
}

let instance: Player | null = null;

// The live player is also kept on globalThis. A dev hot-reload of this module (or of
// anything it imports, like api.ts) re-runs it and would create a second Player with
// its own <audio> while the old one keeps playing. Vite only runs dispose hooks for
// the edited module itself, so the registry is what reliably catches that case.
const registry = globalThis as { __musicPlayer?: Player };

/** Created lazily, after sign-in, so restore() has a session to talk to. */
export function getPlayer() {
	if (!instance) {
		const prev = registry.__musicPlayer;
		// (An instance from an older module version may predate `position`.)
		const handoff = prev ? { time: prev.position ?? prev.currentTime, playing: prev.playing } : null;
		// Destroy first: it writes the queue snapshot the new instance restores from.
		prev?.destroy();
		instance = new Player();
		registry.__musicPlayer = instance;
		if (handoff) {
			instance.seek(handoff.time);
			if (handoff.playing) instance.resume();
		}
	}
	return instance;
}

export type { Player };
