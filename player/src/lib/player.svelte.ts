import { coverUrl, getPlayQueue, savePlayQueue, scrobble, streamUrl } from './api';
import { sleepTimer } from './sleepTimer.svelte';
import type { Song } from './types';

export type Repeat = 'off' | 'all' | 'one';

const QUEUE_KEY = 'music.queue';

/**
 * Merge `b` into `a` spread evenly with a little jitter, keeping each list's own
 * order (ported from the main frontend's queueHelpers.interleaveEvenly).
 */
function interleaveEvenly<T>(a: T[], b: T[], jitter = 0.8): T[] {
	const out: T[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length || j < b.length) {
		if (j >= b.length) {
			out.push(a[i++]);
			continue;
		}
		if (i >= a.length) {
			out.push(b[j++]);
			continue;
		}
		const progressA = (i + 0.5) / a.length;
		const progressB = (j + 0.5 + (Math.random() - 0.5) * jitter) / b.length;
		if (progressA <= progressB) out.push(a[i++]);
		else out.push(b[j++]);
	}
	return out;
}

function shuffled<T>(items: T[]): T[] {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

/**
 * Single audio engine. The queue is the play order; when shuffle is on, the
 * original order is kept in `unshuffled` so turning shuffle off restores it.
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
	castState = $state<'disconnected' | 'connecting' | 'connected'>('disconnected');

	current = $derived(this.index >= 0 ? (this.queue[this.index] ?? null) : null);
	upNext = $derived(this.queue.slice(this.index + 1));

	private audio: HTMLAudioElement;
	private unshuffled: Song[] | null = null;
	private scrobbled = false;
	private pendingSeek = 0;
	private saveTimer: ReturnType<typeof setTimeout> | undefined;
	/** Lets only one tab play at a time (like music.apple.com). */
	private channel: BroadcastChannel | null = null;
	private readonly tabId = Math.random().toString(36).slice(2);
	private destroyed = false;

	constructor() {
		this.audio = new Audio();
		this.audio.preload = 'auto';
		const a = this.audio;
		a.addEventListener('play', () => {
			this.playing = true;
			this.channel?.postMessage({ type: 'playing', tab: this.tabId });
		});
		a.addEventListener('pause', () => {
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
			this.duration = Number.isFinite(a.duration) ? a.duration : (this.current?.duration ?? 0);
		});
		a.addEventListener('durationchange', () => {
			if (Number.isFinite(a.duration)) this.duration = a.duration;
		});
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
		this.setupMediaSession();
		this.setupRemotePlayback();
		if ('BroadcastChannel' in window) {
			this.channel = new BroadcastChannel('music-player');
			this.channel.onmessage = (e) => {
				if (e.data?.type === 'playing' && e.data.tab !== this.tabId) this.audio.pause();
			};
		}
		this.restore();
	}

	// ---- queue control -------------------------------------------------------

	playList(songs: Song[], start = 0, opts: { shuffle?: boolean } = {}) {
		if (!songs.length) return;
		this.unshuffled = null;
		if (opts.shuffle) {
			this.shuffle = true;
			this.unshuffled = [...songs];
			this.queue = shuffled(songs);
			this.load(0, true);
		} else {
			if (this.shuffle) {
				// Keep shuffle on like Apple Music: start with the tapped song, shuffle the rest.
				const first = songs[start];
				this.unshuffled = [...songs];
				this.queue = [first, ...shuffled(songs.filter((_, i) => i !== start))];
				this.load(0, true);
			} else {
				this.queue = [...songs];
				this.load(start, true);
			}
		}
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
		if (i === this.index) return;
		this.queue.splice(i, 1);
		if (i < this.index) this.index--;
		this.persist();
	}

	moveUpNext(from: number, to: number) {
		const [song] = this.queue.splice(from, 1);
		this.queue.splice(to, 0, song);
		if (from < this.index && to >= this.index) this.index--;
		else if (from > this.index && to <= this.index) this.index++;
		this.persist();
	}

	jumpTo(i: number) {
		this.load(i, true);
	}

	clearUpNext() {
		this.queue.splice(this.index + 1);
		this.persist();
	}

	// ---- transport -----------------------------------------------------------

	toggle() {
		if (!this.current) return;
		if (this.audio.paused) this.resume();
		else this.audio.pause();
	}

	resume() {
		if (!this.audio.src && this.current) this.load(this.index, true, this.currentTime);
		else this.audio.play().catch(() => (this.playing = false));
	}

	pause() {
		this.audio.pause();
	}

	next() {
		if (this.index < this.queue.length - 1) this.load(this.index + 1, true);
		else if (this.repeat === 'all' && this.queue.length) this.load(0, true);
		else {
			this.audio.pause();
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
				const rest = this.queue.filter((_, i) => i !== this.index);
				this.queue = [cur, ...shuffled(rest)];
				this.index = 0;
			}
		} else {
			this.shuffle = false;
			if (this.unshuffled) {
				this.queue = this.unshuffled;
				this.index = cur ? Math.max(0, this.queue.findIndex((s) => s.id === cur.id)) : -1;
			}
			this.unshuffled = null;
		}
		this.persist();
	}

	cycleRepeat() {
		this.repeat = this.repeat === 'off' ? 'all' : this.repeat === 'all' ? 'one' : 'off';
		this.persist();
	}

	// ---- internals -----------------------------------------------------------

	private currentOfflineRevoke: (() => void) | null = null;

	private releaseOfflineUrl() {
		if (this.currentOfflineRevoke) {
			this.currentOfflineRevoke();
			this.currentOfflineRevoke = null;
		}
	}

	private async load(i: number, autoplay: boolean, startAt = 0) {
		const song = this.queue[i];
		if (!song) return;
		
		const targetIndex = i;
		this.index = i;
		this.error = null;
		this.scrobbled = false;
		this.currentTime = startAt;
		this.duration = song.duration ?? 0;
		this.pendingSeek = startAt;
		
		if (autoplay) this.buffering = true;

		let src = streamUrl(song.id);
		
		const { getSession } = await import('./api');
		const session = getSession();
		if (session?.username) {
			try {
				const { createOfflineTrackUrl } = await import('./offline');
				const offline = await createOfflineTrackUrl(session.username, song.id);
				if (offline) {
					src = offline.url;
					this.releaseOfflineUrl();
					this.currentOfflineRevoke = offline.revoke;
				}
			} catch {
				// Fallback to stream URL
			}
		}

		// Bail out if the user skipped to another track while we were awaiting DB
		if (this.index !== targetIndex) {
			if (src.startsWith('blob:')) URL.revokeObjectURL(src);
			return;
		}

		this.audio.src = src;
		if (autoplay) {
			this.audio.play().catch(() => {
				this.playing = false;
				this.buffering = false;
			});
			scrobble(song.id, false);
		}
		this.updateMetadata();
		this.persist();
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
	}

	private onEnded() {
		if (this.repeat === 'one') {
			this.scrobbled = false;
			this.audio.currentTime = 0;
			this.audio.play().catch(() => (this.playing = false));
			return;
		}

		// Handle this synchronously. A dynamic import can be deferred while the
		// PWA is backgrounded, leaving the audio element stopped at the end.
		if (!sleepTimer.onTrackEnded()) this.next();
	}

	private setupRemotePlayback() {
		const remote = (this.audio as HTMLAudioElement & { remote?: RemotePlayback }).remote;
		if (!remote) return;
		remote.watchAvailability((available) => (this.castAvailable = available)).catch(() => {
			// Some browsers can't monitor continuously; assume a picker may exist.
			this.castAvailable = true;
		});
		const sync = () => (this.castState = remote.state);
		remote.addEventListener('connecting', sync);
		remote.addEventListener('connect', sync);
		remote.addEventListener('disconnect', sync);
	}

	/** Opens the system device picker; false when this browser has none. */
	async pickOutput(): Promise<boolean> {
		const remote = (this.audio as HTMLAudioElement & { remote?: RemotePlayback }).remote;
		if (!remote) return false;
		try {
			await remote.prompt();
			return true;
		} catch (e) {
			// NotAllowedError = user dismissed the picker, which still counts as shown.
			return e instanceof DOMException && e.name === 'NotAllowedError';
		}
	}

	private setupMediaSession() {
		if (!('mediaSession' in navigator)) return;
		const ms = navigator.mediaSession;
		const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
			['play', () => this.resume()],
			['pause', () => this.pause()],
			['previoustrack', () => this.previous()],
			['nexttrack', () => this.next()],
			['seekto', (d) => d.seekTime !== undefined && this.seek(d.seekTime)],
			['seekbackward', (d) => this.seek(Math.max(0, this.currentTime - (d.seekOffset ?? 10)))],
			['seekforward', (d) => this.seek(this.currentTime + (d.seekOffset ?? 10))]
		];
		for (const [action, handler] of handlers) {
			try {
				ms.setActionHandler(action, handler);
			} catch {
				/* action unsupported */
			}
		}
	}

	private updateMetadata() {
		const song = this.current;
		if (!song || !('mediaSession' in navigator)) return;
		const artwork = [300, 600].map((size) => ({
			src: coverUrl(song.coverArt, size) ?? '',
			sizes: `${size}x${size}`,
			type: 'image/jpeg'
		}));
		navigator.mediaSession.metadata = new MediaMetadata({
			title: song.title,
			artist: song.displayArtist ?? song.artist ?? '',
			album: song.album ?? '',
			artwork: song.coverArt ? artwork : []
		});
	}

	private updatePosition() {
		if (!('mediaSession' in navigator) || !this.duration) return;
		try {
			navigator.mediaSession.setPositionState({
				duration: this.duration,
				position: Math.min(this.currentTime, this.duration),
				playbackRate: this.audio.playbackRate
			});
		} catch {
			/* invalid state mid-load */
		}
	}

	/** Local snapshot always; the server copy (cross-device resume) on pause and track change. */
	private writeSnapshot() {
		try {
			localStorage.setItem(
				QUEUE_KEY,
				JSON.stringify({
					queue: this.queue,
					index: this.index,
					time: this.currentTime,
					shuffle: this.shuffle,
					repeat: this.repeat,
					unshuffled: this.unshuffled
				})
			);
		} catch {
			/* storage full or unavailable */
		}
	}

	private persist(toServer = false) {
		// A replaced instance must never write over its successor's snapshot.
		if (this.destroyed) return;
		clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => this.writeSnapshot(), 300);
		if (toServer || !this.playing) {
			savePlayQueue(
				this.queue.map((s) => s.id),
				this.current?.id,
				Math.floor(this.currentTime * 1000)
			);
		}
	}

	private async restore() {
		try {
			const raw = localStorage.getItem(QUEUE_KEY);
			if (raw) {
				const saved = JSON.parse(raw);
				this.queue = saved.queue ?? [];
				this.index = Math.min(saved.index ?? -1, this.queue.length - 1);
				this.currentTime = saved.time ?? 0;
				this.duration = this.current?.duration ?? 0;
				this.shuffle = !!saved.shuffle;
				this.repeat = saved.repeat ?? 'off';
				this.unshuffled = saved.unshuffled ?? null;
				this.updateMetadata();
				if (this.queue.length) return;
			}
		} catch {
			/* corrupt snapshot */
		}
		const remote = await getPlayQueue();
		if (remote && !this.queue.length) {
			this.queue = remote.songs;
			this.index = Math.max(0, remote.songs.findIndex((s) => s.id === remote.current));
			this.currentTime = remote.position / 1000;
			this.duration = this.current?.duration ?? 0;
			this.updateMetadata();
		}
	}

	/** Stops and releases the audio element so it can never keep playing orphaned. */
	destroy() {
		this.writeSnapshot();
		this.destroyed = true;
		this.audio.pause();
		this.audio.removeAttribute('src');
		this.audio.load();
		this.releaseOfflineUrl();
		this.channel?.close();
		this.channel = null;
		clearTimeout(this.saveTimer);
	}

	/** Called on sign-out. */
	reset() {
		this.audio.pause();
		this.audio.removeAttribute('src');
		this.releaseOfflineUrl();
		this.queue = [];
		this.index = -1;
		this.unshuffled = null;
		try {
			localStorage.removeItem(QUEUE_KEY);
		} catch {
			/* ignore */
		}
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
