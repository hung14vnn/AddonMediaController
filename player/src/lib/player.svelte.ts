import { getPlayQueue, savePlayQueue, scrobble, streamUrl } from './api';
import { Autoplay } from './playback/autoplay';
import { resolveDuration } from './playback/duration';
import { InterruptionGuard } from './playback/interruptions';
import { clearMediaSession, setMediaMetadata, setMediaPosition, setupMediaSession } from './playback/mediaSession';
import { PreparedTracks } from './playback/preparedTracks';
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
import { StallWatchdog } from './playback/stallWatchdog';
import { clearSnapshot, readSnapshot, writeSnapshot } from './playback/snapshot';
import { sleepTimer } from './sleepTimer.svelte';
import type { Song } from './types';

export type { Repeat };

/**
 * Seconds before the end at which the next track is downloaded into memory. Once the
 * audio stops, Android may cut a screen-off PWA's network, so the next track must not
 * need it.
 */
const PREFETCH_LEAD_S = 45;

/**
 * Single audio engine. The queue is the play order; when shuffle is on, the
 * original order is kept in `unshuffled` so turning shuffle off restores it.
 * Platform work (lock screen, AirPlay, iOS interruptions, prefetch) lives in
 * ./playback; this class owns the reactive state and the track-change logic.
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

	current = $derived(this.index >= 0 ? (this.queue[this.index] ?? null) : null);
	upNext = $derived(this.queue.slice(this.index + 1));

	private audio: HTMLAudioElement;
	private unshuffled: Song[] | null = null;
	private scrobbled = false;
	/** Server-reported length that playback ends at in place of a misread `audio.duration`. */
	private durationCap = 0;
	private cappedEnd = false;
	private pendingSeek = 0;
	private loadToken = 0;
	private saveTimer: ReturnType<typeof setTimeout> | undefined;
	private destroyed = false;

	private prepared = new PreparedTracks();
	private autoplay: Autoplay;
	private interruptions: InterruptionGuard;
	private singleTab: SingleTab;
	private watchdog: StallWatchdog;

	constructor() {
		this.audio = new Audio();
		this.audio.preload = 'auto';
		const a = this.audio;
		this.autoplay = new Autoplay(a, () => {
			this.playing = false;
			this.buffering = false;
		});
		this.interruptions = new InterruptionGuard(a, () => this.autoplay.start());
		this.singleTab = new SingleTab(() => this.pause());
		this.watchdog = new StallWatchdog(a, () => this.reloadCurrent());

		a.addEventListener('play', () => {
			this.playing = true;
			this.autoplay.cancel();
			this.singleTab.announcePlaying();
		});
		a.addEventListener('pause', () => {
			this.interruptions.notePause();
			this.playing = false;
			this.persist(true);
		});
		a.addEventListener('waiting', () => (this.buffering = true));
		a.addEventListener('playing', () => (this.buffering = false));
		a.addEventListener('canplay', () => (this.buffering = false));
		a.addEventListener('loadedmetadata', () => {
			if (this.pendingSeek) {
				a.currentTime = this.pendingSeek;
				this.pendingSeek = 0;
			}
			this.applyDuration();
		});
		a.addEventListener('durationchange', () => this.applyDuration());
		a.addEventListener('timeupdate', () => this.onTime());
		a.addEventListener('ended', () => this.onEnded());
		a.addEventListener('error', () => {
			if (!a.src || !this.current) return;
			this.error = `Couldn't play “${this.current.title}”`;
			this.buffering = false;
		});
		a.addEventListener('volumechange', () => {
			this.volume = a.volume;
			this.muted = a.muted;
		});

		setupMediaSession(a, {
			play: () => this.resume(),
			pause: () => this.pause(),
			previous: (backgroundSafe) => this.previous(backgroundSafe),
			next: (backgroundSafe) => this.next(backgroundSafe),
			seek: (seconds) => this.seek(seconds),
			currentTime: () => this.currentTime
		});
		watchRemotePlayback(a, {
			availability: (available) => (this.castAvailable = available),
			state: (state, stalled) => {
				this.castState = state;
				this.castStalled = stalled;
			}
		});
		window.addEventListener('pagehide', this.onPageHide);
		this.restore();
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
	interleaveUpNext(songs: Song[]) {
		if (!songs.length) return;
		if (!this.current) return this.playList(songs);
		const start = this.index + 1;
		this.queue = [...this.queue.slice(0, start), ...interleaveEvenly(this.queue.slice(start), songs)];
		this.unshuffled?.push(...songs);
		this.persist();
	}

	removeAt(i: number) {
		const index = removeAt(this.queue, this.index, i);
		if (index === null) return;
		this.index = index;
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
		if (this.audio.paused) this.resume();
		else this.audio.pause();
	}

	resume() {
		if (!this.audio.src && this.current) this.load(this.index, true, this.currentTime);
		// A dead stream ignores play(); only a fresh request at this position recovers it.
		else if (this.current && this.watchdog.needsReload()) this.load(this.index, true, this.currentTime);
		else this.audio.play().catch(() => (this.playing = false));
	}

	pause() {
		// An explicit pause (or another tab taking over) cancels any pending retry or
		// resume-after-call.
		this.autoplay.cancel();
		this.interruptions.userPause();
		this.audio.pause();
	}

	/** `backgroundSafe`: the page may be hidden, so don't await IndexedDB/imports first. */
	next(backgroundSafe = false) {
		const i = nextIndex(this.queue.length, this.index, this.repeat);
		if (i >= 0) this.load(i, true, 0, !backgroundSafe);
		else {
			this.audio.pause();
			this.seek(0);
		}
	}

	previous(backgroundSafe = false) {
		// Like every music app: restart the song unless we're within the first 3 seconds.
		if (this.audio.currentTime > 3 || this.index <= 0) this.seek(0);
		else this.load(this.index - 1, true, 0, !backgroundSafe);
	}

	seek(seconds: number) {
		if (seconds < this.durationCap - 1) this.cappedEnd = false;
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

	/**
	 * Start track `i`. `waitForOffline` lets manual changes look for a downloaded
	 * copy first; changes that may run in the background (`ended`, lock screen
	 * while hidden) pass false, since those awaits can be suspended there.
	 */
	private async load(i: number, autoplay: boolean, startAt = 0, waitForOffline = true) {
		const song = this.queue[i];
		if (!song) return;

		const targetIndex = i;
		const token = ++this.loadToken;
		this.index = i;
		this.error = null;
		this.scrobbled = false;
		this.durationCap = 0;
		this.cappedEnd = false;
		this.prepared.startTrack();
		this.watchdog.track(song.id);
		this.currentTime = startAt;
		this.duration = song.duration ?? 0;
		this.pendingSeek = startAt;

		if (autoplay) this.buffering = true;

		const ready = this.prepared.take(song.id);
		let src = ready ?? streamUrl(song.id);
		if (!ready && waitForOffline) {
			const offline = await this.prepared.lookupOffline(song.id);
			if (offline) {
				src = offline.url;
				this.prepared.adopt(offline);
			}
		}

		// Bail out if the user skipped to another track while we were awaiting DB
		if (this.index !== targetIndex || token !== this.loadToken) {
			if (src.startsWith('blob:')) URL.revokeObjectURL(src);
			return;
		}

		// Safari/iOS can keep the old decoded resource alive when src is replaced
		// immediately after `ended`. Explicitly reset the media element before
		// loading the next source so playback state and audio output stay aligned.
		this.audio.pause();
		this.audio.removeAttribute('src');
		this.audio.load();
		this.audio.src = src;
		this.audio.load();
		if (autoplay) {
			this.autoplay.start();
			scrobble(song.id, false);
		}
		setMediaMetadata(this.current);
		this.persist();
		const next = this.queue[this.index + 1];
		if (next) this.prepared.prepareOffline(next, () => !this.destroyed && this.queue[this.index + 1]?.id === next.id);
	}

	/** The track `next()` would load when the current one ends. */
	private upcoming(): Song | undefined {
		return this.queue[this.index + 1] ?? (this.repeat === 'all' ? this.queue[0] : undefined);
	}

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
		if (Math.floor(a.currentTime) % 5 === 0) this.updatePosition();
		if (dur > 0 && dur - a.currentTime <= PREFETCH_LEAD_S) this.prefetchUpcoming();
		// The real audio is over; don't sit through the silence up to the misread length.
		if (this.durationCap && !this.cappedEnd && a.currentTime >= this.durationCap - 0.25) {
			this.cappedEnd = true;
			this.onEnded();
		}
	}

	private prefetchUpcoming() {
		const next = this.upcoming();
		if (!next || next.id === this.current?.id) return;
		this.prepared.prefetch(next, streamUrl(next.id), () => !this.destroyed && this.upcoming()?.id === next.id);
	}

	private applyDuration() {
		const resolved = resolveDuration(this.audio.duration, this.current?.duration ?? 0, this.duration);
		this.duration = resolved.duration;
		if (resolved.cap !== undefined) this.durationCap = resolved.cap;
	}

	/**
	 * The stream stopped delivering mid-track: fetch it again from where it froze.
	 * Background-safe (no IndexedDB/import awaits) since it can fire with the screen off.
	 */
	private reloadCurrent() {
		if (!this.current) return;
		this.buffering = true;
		this.load(this.index, true, this.currentTime, false);
	}

	private onEnded() {
		if (this.repeat === 'one') {
			this.scrobbled = false;
			this.cappedEnd = false;
			this.audio.currentTime = 0;
			this.autoplay.start();
			return;
		}

		// Track changes from `ended` must not wait for IndexedDB/dynamic imports:
		// those callbacks can be suspended while a PWA is backgrounded.
		if (!sleepTimer.onTrackEnded()) this.next(true);
	}

	private updatePosition() {
		setMediaPosition(this.duration, this.currentTime, this.audio.playbackRate);
	}

	/**
	 * Swiping an iOS home-screen app away can leave its WebKit process, and the audio,
	 * alive for a while. `pagehide` with persisted=false means the page is being torn
	 * down (not bfcached), so stop rather than play on with no UI. Best effort: iOS
	 * does not always deliver it. The snapshot keeps the position for next launch.
	 */
	private readonly onPageHide = (e: PageTransitionEvent) => {
		if (e.persisted) return;
		this.saveSnapshot();
		this.pause();
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
		this.audio.pause();
		this.audio.removeAttribute('src');
		this.audio.load();
		this.prepared.clear();
		this.singleTab.close();
		this.autoplay.dispose();
		this.interruptions.dispose();
		this.watchdog.dispose();
		window.removeEventListener('pagehide', this.onPageHide);
		clearTimeout(this.saveTimer);
	}

	/** Called on sign-out. */
	reset() {
		this.autoplay.cancel();
		this.audio.pause();
		this.audio.removeAttribute('src');
		this.prepared.clear();
		this.queue = [];
		this.index = -1;
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
