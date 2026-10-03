import { getPlayQueue, getSession, savePlayQueue, scrobble, streamUrl } from './api';
import { logPlayback } from './playback/debugLog';
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
import { SingleTab } from './playback/singleTab';
import { clearSnapshot, readSnapshot, writeSnapshot } from './playback/snapshot';
import { sleepTimer } from './sleepTimer.svelte';
import type { Song } from './types';

export type { Repeat };

interface ObjectUrl {
	url: string;
	revoke: () => void;
}

/** A downloaded track's blob URL, tagged with the song it plays. */
interface OfflineCopy {
	id: string;
	copy: ObjectUrl;
}

interface PreloadEntry {
	url: string;
	element: HTMLAudioElement;
}

/** Match the main frontend: park a native stream after 15 seconds without progress. */
const STALL_TIMEOUT_MS = 15_000;
const STALL_CHECK_MS = 2_000;
/** Warm only the next native stream, like Monochrome's second audio element. */
const PRELOAD_LEAD_S = 45;

/** HTMLMediaElement.HAVE_FUTURE_DATA: enough buffered to keep playing. */
const HAVE_FUTURE_DATA = 3;

/** Unplayable tracks skipped in a row before giving up. */
const MAX_ERROR_SKIPS = 3;

/** Media element events written to the playback log (timeupdate is too chatty). */
const LOGGED_EVENTS = ['play', 'pause', 'waiting', 'playing', 'canplay', 'stalled', 'ended', 'error', 'emptied', 'abort'];

/** A browser-reported length this much over the server's means the browser misread it. */
const DURATION_MISMATCH_RATIO = 1.25;

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
 */
class Player {
	queue = $state<Song[]>([]);
	index = $state(-1);
	playing = $state(false);
	buffering = $state(false);
	currentTime = $state(0);
	duration = $state(0);
	volume = $state(1);
	muted = $state(false);
	shuffle = $state(false);
	repeat = $state<Repeat>('off');
	error = $state<string | null>(null);
	/** Remote Playback API (Chromecast etc. on Chrome/Android; AirPlay picker on Safari). */
	castAvailable = $state(false);
	castState = $state<CastState>('disconnected');
	/** Stuck 'connecting': the audio has left the device but nothing plays it. */
	castStalled = $state(false);

	/** What the play/pause button shows: playing, or loading towards it (with a spinner). */
	active = $derived(this.playing || this.buffering);
	current = $derived(this.index >= 0 ? (this.queue[this.index] ?? null) : null);
	upNext = $derived(this.queue.slice(this.index + 1));

	private audio: HTMLAudioElement;
	private preloadAudio: HTMLAudioElement;
	private unshuffled: Song[] | null = null;
	private scrobbled = false;
	private pendingSeek = 0;
	/** Invalidates a load still waiting on the offline lookup when another one starts. */
	private loadToken = 0;
	/** Offline copy now playing, revoked on the next change. */
	private playingOffline: OfflineCopy | null = null;
	/**
	 * The upcoming track, ready to start without the network when it was explicitly
	 * downloaded for offline use.
	 */
	private nextReady: OfflineCopy | null = null;
	/** Stream descriptors and their warmed native element, keyed like Monochrome. */
	private preloadCache = new Map<string, PreloadEntry>();
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
	private stallTimer: ReturnType<typeof setInterval> | undefined;
	private lastProgressAt = 0;
	private lastProgressTime = -1;
	private saveTimer: ReturnType<typeof setTimeout> | undefined;
	private destroyed = false;
	private singleTab: SingleTab;
	private interruptions: InterruptionGuard;
	private stopRemoteWatch: () => void = () => {};

	constructor() {
		this.audio = new Audio();
		this.audio.preload = 'auto';
		this.preloadAudio = new Audio();
		this.preloadAudio.preload = 'auto';
		const a = this.audio;
		this.singleTab = new SingleTab(() => this.pause());
		this.interruptions = new InterruptionGuard(a, () => this.resumeAfterInterruption());

		// Event flow follows Navidrome's player: a track change sets src and load()s,
		// `canplay` (re)starts playback that is wanted, and a `waiting` element that
		// already has enough buffered is kicked with play() again.
		a.addEventListener('play', () => {
			if (this.audio !== a) return;
			this.playing = true;
			this.resumeWhenVisible = false;
			this.singleTab.announcePlaying();
		});
		a.addEventListener('pause', () => {
			if (this.audio !== a) return;
			this.playing = false;
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
			if (this.audio === a) this.buffering = false;
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
		a.addEventListener('playing', () => {
			if (this.audio === a) this.errorSkips = 0;
		});
		for (const type of LOGGED_EVENTS) {
			a.addEventListener(type, () => {
				if (this.audio === a) {
					logPlayback(type, `t=${a.currentTime.toFixed(1)} rs=${a.readyState} ns=${a.networkState} paused=${a.paused} vol=${a.volume} muted=${a.muted}`);
				}
			});
		}
		a.addEventListener('volumechange', () => {
			if (this.audio !== a) return;
			this.volume = a.volume;
			this.muted = a.muted;
		});
		this.bindPreloadAudio(this.preloadAudio);

		this.bindActiveAudio(a);
		window.addEventListener('pagehide', this.onPageHide);
		document.addEventListener('visibilitychange', this.onVisibilityChange);
		this.restore();
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
			currentTime: () => this.currentTime
		});
	}

	/** Keep the standby element observable so it can become the active element. */
	private bindPreloadAudio(a: HTMLAudioElement) {
		a.addEventListener('play', () => {
			if (this.audio !== a) return;
			this.playing = true;
			this.resumeWhenVisible = false;
			this.singleTab.announcePlaying();
		});
		a.addEventListener('pause', () => {
			if (this.audio !== a) return;
			this.playing = false;
			if (!this.buffering) this.playRequested = false;
			this.persist(true);
		});
		a.addEventListener('waiting', () => {
			if (this.audio !== a) return;
			this.buffering = true;
			if (this.playRequested && a.readyState >= HAVE_FUTURE_DATA) this.play();
		});
		a.addEventListener('playing', () => {
			if (this.audio === a) this.buffering = false;
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
		a.addEventListener('playing', () => {
			if (this.audio === a) this.errorSkips = 0;
		});
		for (const type of LOGGED_EVENTS) {
			a.addEventListener(type, () => {
				if (this.audio === a) {
					logPlayback(type, `t=${a.currentTime.toFixed(1)} rs=${a.readyState} ns=${a.networkState} paused=${a.paused} vol=${a.volume} muted=${a.muted}`);
				}
			});
		}
		a.addEventListener('volumechange', () => {
			if (this.audio !== a) return;
			this.volume = a.volume;
			this.muted = a.muted;
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
		if (!this.audio.src && this.current) this.load(this.index, true, this.currentTime);
		else this.play();
	}

	pause() {
		logPlayback('pause-request');
		this.playRequested = false;
		this.resumeWhenVisible = false;
		this.buffering = false;
		this.interruptions.userPause();
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
		this.currentTime = seconds;
		if (this.audio.src) this.audio.currentTime = seconds;
		else this.pendingSeek = seconds;
		this.updatePosition();
	}

	setVolume(v: number) {
		this.audio.volume = Math.max(0, Math.min(1, v));
		if (v > 0) this.audio.muted = false;
	}

	toggleMute() {
		this.audio.muted = !this.audio.muted;
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
		this.persist();
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

	/** Start track `i`, from a downloaded copy when there is one. */
	private async load(i: number, autoplay: boolean, startAt = 0) {
		const song = this.queue[i];
		if (!song) return;
		// A manual selection (or a queue advance) can make the warmed next track
		// obsolete. Keep it only when the selected song is exactly that track;
		// otherwise stop the standby request so it cannot consume resources or
		// accidentally become part of the new playback session.
		if (!this.preloadCache.has(song.id)) this.clearPreload();

		const token = ++this.loadToken;
		this.index = i;
		this.error = null;
		this.scrobbled = false;
		this.durationCap = 0;
		this.currentTime = startAt;
		this.duration = song.duration ?? 0;
		this.pendingSeek = startAt;
		this.lastProgressAt = performance.now();
		this.lastProgressTime = -1;
		this.playing = false;
		this.playRequested = autoplay;
		this.buffering = autoplay;
		if (autoplay) this.armStallCheck();

		let offline: OfflineCopy | null = null;
		if (this.playingOffline?.id === song.id) {
			// Restarting the same track: keep its URL.
			offline = this.playingOffline;
			this.playingOffline = null;
		} else if (this.nextReady?.id === song.id) {
			offline = this.nextReady;
			this.nextReady = null;
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
		this.releaseOffline();
		this.playingOffline = offline;
		const preload = this.preloadCache.get(song.id);
		const useWarmedAudio = Boolean(preload && preload.element === this.preloadAudio && preload.element.src && !offline);
		if (useWarmedAudio) {
			const oldAudio = this.audio;
			this.preloadAudio.volume = oldAudio.volume;
			this.preloadAudio.muted = oldAudio.muted;
			this.preloadAudio.playbackRate = oldAudio.playbackRate;
			this.audio = this.preloadAudio;
			this.preloadAudio = oldAudio;
			this.bindActiveAudio(this.audio);
			// The old active element may have autoplay=true. It is now the
			// standby element, so it must never start a newly preloaded source.
			this.preloadAudio.autoplay = false;
			oldAudio.pause();
			oldAudio.removeAttribute('src');
			oldAudio.load();
			this.preloadCache.delete(song.id);
			// The standby element may have emitted `canplay` before it became
			// active. Do not leave the UI in buffering state waiting for an event
			// that has already happened.
			if (this.audio.readyState >= HAVE_FUTURE_DATA) this.buffering = false;
		}

		logPlayback('load', `id=${song.id} "${song.title}" at=${startAt.toFixed(1)} ${offline ? 'ready (offline/prefetched)' : 'stream'}`);
		this.audio.autoplay = autoplay;
		this.audio.volume = this.volume;
		this.audio.muted = this.muted;
		if (!useWarmedAudio) {
			this.audio.src = offline?.copy.url ?? streamUrl(song.id);
			this.audio.load();
		} else if (startAt > 0) {
			this.audio.currentTime = startAt;
		}
		if (autoplay) {
			// Unlike Navidrome, play() right away rather than waiting for `canplay`: a cold
			// YouTube track takes seconds to arrive, and Android/iOS refuse to start audio
			// from a background page that has been silent that long. `canplay` still retries.
			this.play();
			scrobble(song.id, false);
		}
		setMediaMetadata(this.current);
		this.persist();
		this.prepareNextOffline();
	}

	/** The track `next()` would load when the current one ends. */
	private upcoming(): Song | undefined {
		return this.queue[this.index + 1] ?? (this.repeat === 'all' ? this.queue[0] : undefined);
	}

	private prepareNextOffline() {
		const next = this.upcoming();
		if (!next || next.id === this.current?.id || this.nextReady?.id === next.id) return;
		void lookupOffline(next.id).then((copy) => {
			if (!copy) return;
			if (this.destroyed || this.upcoming()?.id !== next.id || this.nextReady?.id === next.id) {
				copy.revoke();
				return;
			}
			this.nextReady?.copy.revoke();
			this.nextReady = { id: next.id, copy };
		});
	}

	/** Warm only the next stream with a second native audio element. */
	private preloadNextStream() {
		const next = this.upcoming();
		if (
			!next ||
			next.id === this.current?.id ||
			this.preloadCache.has(next.id) ||
			this.nextReady?.id === next.id
		) {
			return;
		}

		const url = streamUrl(next.id);
		if (!url) return;
		// A previous handoff can leave this native element with autoplay=true.
		// Preloading must never be allowed to start playback by itself.
		this.preloadAudio.autoplay = false;
		this.preloadAudio.pause();
		this.preloadAudio.removeAttribute('src');
		this.preloadAudio.load();
		this.preloadAudio.preload = 'auto';
		this.preloadAudio.src = url;
		this.preloadAudio.load();
		this.preloadCache.clear();
		this.preloadCache.set(next.id, { url, element: this.preloadAudio });
		logPlayback('preload-next', `id=${next.id} "${next.title}"`);
	}

	private clearPreload() {
		this.preloadAudio.pause();
		this.preloadAudio.autoplay = false;
		this.preloadAudio.removeAttribute('src');
		this.preloadAudio.load();
		this.preloadCache.clear();
	}

	private play() {
		this.playRequested = true;
		this.armStallCheck();
		const token = this.loadToken;
		this.audio.play().then(() => {
			// A warmed element can resolve play() without emitting a new
			// canplay/playing event after the handoff. The resolved promise means
			// playback was accepted; reflect that immediately in the controls.
			if (token === this.loadToken && !this.audio.paused) {
				this.playing = true;
				this.buffering = false;
			}
		}).catch((e: unknown) => {
			logPlayback('play-rejected', e instanceof DOMException ? `${e.name}: ${e.message}` : String(e));
			// A track change interrupted this play(); the new source's `canplay` owns it now.
			if (token !== this.loadToken) return;
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
		if (document.hidden || !this.resumeWhenVisible || !this.current) return;
		this.resumeWhenVisible = false;
		// A source that failed while the network was cut can't just be played again.
		if (this.audio.error || !this.audio.src) {
			this.errorRetriedFor = null;
			this.load(this.index, true, this.currentTime);
		} else this.play();
	};

	private onTime() {
		const a = this.audio;
		this.currentTime = a.currentTime;
		const song = this.current;
		const dur = this.duration || song?.duration || 0;
		// Last.fm rule: scrobble after half the track or 4 minutes, whichever first.
		if (song && !this.scrobbled && dur > 30 && (a.currentTime >= dur / 2 || a.currentTime >= 240)) {
			this.scrobbled = true;
			scrobble(song.id, true);
		}
		if (a.currentTime !== this.lastProgressTime) {
			this.lastProgressTime = a.currentTime;
			this.lastProgressAt = performance.now();
		}
		if (Math.floor(a.currentTime) % 5 === 0) this.updatePosition();
		if (dur > 0 && dur - a.currentTime <= PRELOAD_LEAD_S) this.preloadNextStream();
		// The real audio is over; don't sit through the silence up to the misread length.
		// Pausing first keeps the element from reaching its own `ended` and advancing twice.
		if (this.durationCap && !a.paused && a.currentTime >= this.durationCap - 0.25) {
			logPlayback('capped-end', `cap=${this.durationCap} media=${a.duration}`);
			a.pause();
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

	private armStallCheck() {
		this.lastProgressAt = performance.now();
		this.stallTimer ??= setInterval(this.checkStall, STALL_CHECK_MS);
	}

	private disarmStallCheck() {
		clearInterval(this.stallTimer);
		this.stallTimer = undefined;
	}

	private readonly checkStall = () => {
		if (!this.playRequested || !this.current) return this.disarmStallCheck();
		// Paused by the system (a call) rather than stuck loading: not a stall.
		if (this.audio.paused && !this.buffering) return;
		if (performance.now() - this.lastProgressAt < STALL_TIMEOUT_MS) return;
		// Match frontend/NativeAudioSource: stop the dead request and let the
		// higher-level error flow retry once, then fallback or skip the track.
		this.disarmStallCheck();
		this.audio.pause();
		logPlayback('stall-timeout', `t=${this.currentTime.toFixed(1)} rs=${this.audio.readyState}`);
		this.onError();
	};

	/**
	 * The source failed (often the server couldn't resolve a YouTube track). Unlike
	 * Navidrome, which stops there, reload it once, then skip to the next track so a
	 * queue left playing with the screen off keeps going.
	 */
	private onError() {
		const a = this.audio;
		const song = this.current;
		if (!a.src || !song) return;
		logPlayback('media-error', `id=${song.id} code=${a.error?.code} ${a.error?.message ?? ''}`);
		if (this.playRequested && this.errorRetriedFor !== song.id) {
			this.errorRetriedFor = song.id;
			this.load(this.index, true, this.currentTime);
			return;
		}
		this.error = `Couldn't play “${song.title}”`;
		if (this.playRequested && this.upcoming() && this.errorSkips < MAX_ERROR_SKIPS) {
			this.errorSkips++;
			this.next();
			return;
		}
		// A failed element can still report "not paused": stop it so the button shows play.
		this.pause();
		this.playing = false;
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
		setMediaPosition(this.duration, this.currentTime, this.audio.playbackRate);
	}

	private releaseOffline() {
		this.playingOffline?.copy.revoke();
		this.playingOffline = null;
	}

	/** Unload the element so it stops fetching and releases the stream. */
	private unload() {
		this.loadToken++;
		this.playRequested = false;
		this.buffering = false;
		this.audio.pause();
		this.audio.removeAttribute('src');
		this.audio.load();
		this.preloadAudio.pause();
		this.preloadAudio.removeAttribute('src');
		this.preloadAudio.load();
		this.preloadCache.clear();
		this.disarmStallCheck();
		this.releaseOffline();
		this.nextReady?.copy.revoke();
		this.nextReady = null;
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
			time: this.currentTime,
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
				Math.floor(this.currentTime * 1000)
			);
		}
	}

	private async restore() {
		const saved = readSnapshot();
		if (saved) {
			this.queue = saved.queue;
			this.index = saved.index;
			this.currentTime = saved.time;
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
			this.currentTime = remote.position / 1000;
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
		window.removeEventListener('pagehide', this.onPageHide);
		document.removeEventListener('visibilitychange', this.onVisibilityChange);
		clearTimeout(this.saveTimer);
	}

	/** Called on sign-out. */
	reset() {
		this.unload();
		this.queue = [];
		this.index = -1;
		this.currentTime = 0;
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
		const handoff = prev ? { time: prev.currentTime, playing: prev.playing } : null;
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
