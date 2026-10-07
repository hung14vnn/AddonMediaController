import { clear as idbClear, createStore, entries as idbEntries, get as idbGet, set as idbSet } from 'idb-keyval';
import { md5 } from './md5';
import type { Album, AlbumListType, Artist, ArtistInfo, Genre, Lyrics, Playlist, Song } from './types';

const API_VERSION = '1.16.1';
const CLIENT = 'hify';
const STORAGE_KEY = 'music.session';

/** Persisted credentials. The plaintext password is never stored, only the md5 token + salt. */
export interface Session {
	/** Base URL including the Subsonic mount, e.g. https://host/subsonic. */
	base: string;
	username?: string;
	token?: string;
	salt?: string;
	apiKey?: string;
}

export class SubsonicError extends Error {
	constructor(
		public code: number,
		message: string
	) {
		super(message);
	}
}

let session: Session | null = load();

function load(): Session | null {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		return raw ? (JSON.parse(raw) as Session) : null;
	} catch {
		return null;
	}
}

export function getSession() {
	return session;
}

export function clearSession() {
	session = null;
	clearCache();
	try {
		localStorage.removeItem(STORAGE_KEY);
	} catch {
		/* storage unavailable */
	}
}

const CACHE_PREFIX = 'music.cache:';
type CacheEntry = { at: number; data: unknown };
const memo = new Map<string, CacheEntry>();
// IndexedDB rather than localStorage: async, and big libraries (getArtists, getStarred2)
// blow past the ~5 MB localStorage quota. Missing in jsdom/private mode → memory only.
const store =
	typeof indexedDB !== 'undefined' ? createStore('music-api-cache-v1', 'entries') : null;

function clearCache() {
	memo.clear();
	if (store) void idbClear(store).catch(() => {});
	purgeLegacyCache();
}

/** Entries written by the old localStorage-backed `cached()`. */
function purgeLegacyCache() {
	try {
		for (const k of Object.keys(localStorage)) if (k.startsWith(CACHE_PREFIX)) localStorage.removeItem(k);
	} catch {
		/* storage unavailable */
	}
}
purgeLegacyCache();

async function readEntry(k: string): Promise<CacheEntry | undefined> {
	const hit = memo.get(k);
	if (hit || !store) return hit;
	try {
		const stored = await idbGet<CacheEntry>(k, store);
		if (stored) remember(k, stored);
		return stored;
	} catch {
		return undefined;
	}
}

const DEFAULT_MAX_AGE = 24 * 60 * 60_000;

function cacheKey(key: string) {
	const user = session?.username ?? (session?.apiKey ? md5(session.apiKey).slice(0, 8) : '');
	return `${CACHE_PREFIX}${session?.base}|${user}|${key}`;
}

export interface CachedOptions<T> {
	/** Age under which the cached copy is returned without revalidating. */
	fresh?: number;
	/** Age under which a stale copy is still returned instantly (and revalidated). */
	maxAge?: number;
	/**
	 * Called with the revalidated data when a stale copy was returned and the network
	 * answer differs, so a view can swap in the fresh result.
	 */
	refresh?: (data: T) => void;
}

/**
 * Stale-while-revalidate: within `fresh` the cached copy is returned as is; up to `maxAge`
 * it's returned instantly and refreshed in the background (see `refresh`); beyond that (or
 * with nothing cached) the network is awaited. Scoped per server + user, cleared on sign-out.
 */
export async function cached<T>(
	key: string,
	fetcher: () => Promise<T>,
	{ fresh = 5 * 60_000, maxAge = DEFAULT_MAX_AGE, refresh }: CachedOptions<T> = {}
): Promise<T> {
	const k = cacheKey(key);
	const hit = await readEntry(k);
	const age = hit ? Date.now() - hit.at : Infinity;
	if (hit && age < fresh) return hit.data as T;

	const req = fetcher().then((data) => {
		// An unchanged answer only bumps the timestamp: no IndexedDB write (structured-cloning
		// a big getArtists payload to disk on every visit is the kind of work that warms phones)
		// and no re-render for the caller. The stringify compare is far cheaper than that write.
		const changed = !hit || JSON.stringify(data) !== JSON.stringify(hit.data);
		const entry = { at: Date.now(), data: changed ? data : hit!.data };
		remember(k, entry);
		if (store && changed) void idbSet(k, entry, store).catch(() => {});
		return { data, changed };
	});
	if (hit && age < maxAge) {
		if (refresh) req.then(({ data, changed }) => changed && refresh(data)).catch(() => {});
		else req.catch(() => {});
		return hit.data as T;
	}
	return req.then(({ data }) => data);
}

// Bound the in-memory copy: big libraries make each entry (artists, a songs page) sizeable.
const MEMO_LIMIT = 60;
function remember(k: string, entry: CacheEntry) {
	memo.delete(k);
	memo.set(k, entry);
	if (memo.size > MEMO_LIMIT) memo.delete(memo.keys().next().value!);
}

/** A value, or a promise of one: `{#await}` renders a plain value synchronously. */
export type Maybe<T> = T | Promise<T>;

/**
 * `cached()` whose in-memory hit comes back as a plain value rather than a promise, so a
 * view revisited in the same session paints its last state in the same frame instead of
 * flashing a spinner; the revalidation still runs (see `refresh`). Pass through otherwise.
 */
export function cachedNow<T>(key: string, fetcher: () => Promise<T>, opts: CachedOptions<T> = {}): Maybe<T> {
	const hit = memo.get(cacheKey(key));
	const usable = hit && Date.now() - hit.at < (opts.maxAge ?? DEFAULT_MAX_AGE);
	// Going back to a page just seen: show it exactly as it was, with no request and so no
	// swap (e.g. Home's random picks), the way a native back gesture behaves.
	if (usable && performance.now() - backNavigationAt < BACK_WINDOW_MS) return hit.data as T;
	const request = cached(key, fetcher, opts);
	if (usable) {
		request.catch(() => {});
		return hit.data as T;
	}
	return request;
}

let backNavigationAt = -Infinity;
// Long enough for the restored view to mount and run its loaders, short enough that a
// later action on that page (retry, sort) still revalidates.
const BACK_WINDOW_MS = 1000;

/** Called by the layout on back/forward navigation; see `cachedNow`. */
export function markBackNavigation() {
	backNavigationAt = performance.now();
}

/** `Promise.all` that stays synchronous when every input already is. */
export function allNow<T extends readonly unknown[]>(values: { [K in keyof T]: Maybe<T[K]> }): Maybe<T> {
	return values.some((v) => v instanceof Promise) ? (Promise.all(values) as Promise<T>) : (values as unknown as T);
}

function randomSalt() {
	const bytes = crypto.getRandomValues(new Uint8Array(8));
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function authParams(s: Session): Record<string, string> {
	const p: Record<string, string> = { v: API_VERSION, c: CLIENT, f: 'json' };
	if (s.apiKey) p.apiKey = s.apiKey;
	else {
		p.u = s.username ?? '';
		p.t = s.token ?? '';
		p.s = s.salt ?? '';
	}
	return p;
}

type Params = Record<string, string | number | boolean | undefined | (string | number)[]>;

function buildUrl(s: Session, endpoint: string, params: Params = {}) {
	const url = new URL(`${s.base.replace(/\/+$/, '')}/rest/${endpoint}`, location.href);
	for (const [k, v] of Object.entries(authParams(s))) url.searchParams.set(k, v);
	for (const [k, v] of Object.entries(params)) {
		if (v === undefined) continue;
		if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(k, String(item)));
		else url.searchParams.set(k, String(v));
	}
	return url.toString();
}

import { logApiError } from './playback/debugLog';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call<T = any>(endpoint: string, params: Params = {}, s: Session | null = session): Promise<T> {
	if (!s) {
		const err = new SubsonicError(10, 'Not signed in');
		logApiError(endpoint, 'Not signed in');
		throw err;
	}
	let res: Response;
	try {
		res = await fetch(buildUrl(s, endpoint, params));
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		logApiError(endpoint, 'Fetch failed', msg);
		throw e;
	}
	let body;
	try {
		body = await res.json();
	} catch {
		const msg = `Server returned ${res.status} (not a Subsonic endpoint?)`;
		logApiError(endpoint, 'Invalid JSON response', msg);
		throw new SubsonicError(0, msg);
	}
	const r = body?.['subsonic-response'];
	if (!r) {
		logApiError(endpoint, 'Unexpected response from server');
		throw new SubsonicError(0, 'Unexpected response from server');
	}
	if (r.status !== 'ok') {
		const msg = r.error?.message ?? 'Request failed';
		logApiError(endpoint, `API Error ${r.error?.code ?? 0}`, msg);
		throw new SubsonicError(r.error?.code ?? 0, msg);
	}
	return r as T;
}

/**
 * Tries `<url>/subsonic` first (DroppedNeedle mounts the API there), then the URL as
 * given, so users can paste the site URL or any plain Subsonic server URL.
 */
export async function login(opts: { server: string; username?: string; password?: string; apiKey?: string }) {
	const server = opts.server.trim().replace(/\/+$/, '').replace(/\/rest$/, '');
	const candidates = server.endsWith('/subsonic') ? [server] : [`${server}/subsonic`, server];
	const salt = randomSalt();
	let lastError: unknown;
	for (const base of candidates) {
		const s: Session = opts.apiKey
			? { base, apiKey: opts.apiKey.trim() }
			: { base, username: opts.username?.trim(), salt, token: md5((opts.password ?? '') + salt) };
		try {
			await call('ping', {}, s);
			session = s;
			localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
			return s;
		} catch (e) {
			lastError = e;
			// An auth error means the endpoint exists and the credentials are wrong.
			if (e instanceof SubsonicError && e.code >= 10) break;
		}
	}
	throw lastError;
}

// ---- URLs -------------------------------------------------------------------

export function coverUrl(id: string | undefined, size = 300) {
	if (!id || !session) return undefined;
	// Snap to a few sizes so the browser/SW cache is shared across views.
	const snapped = [64, 150, 300, 600, 1200].find((n) => n >= size) ?? 1200;
	return buildUrl(session, 'getCoverArt', { id, size: snapped });
}

export function streamUrl(id: string) {
	return session ? buildUrl(session, 'stream', { id }) : '';
}

/**
 * For secondary shelves: servers may reject optional list types (DroppedNeedle has
 * no ratings, so `highest` fails), and one failed shelf shouldn't blank the page.
 */
export function optional<T>(p: Promise<T[]>): Promise<T[]>;
export function optional<T>(p: Maybe<T[]>): Maybe<T[]>;
export function optional<T>(p: Maybe<T[]>): Maybe<T[]> {
	return p instanceof Promise ? p.catch(() => []) : p;
}

// ---- Library ----------------------------------------------------------------

export async function getAlbumList(type: AlbumListType, size = 30, offset = 0, extra: Params = {}) {
	const r = await call('getAlbumList2', { type, size, offset, ...extra });
	return (r.albumList2?.album ?? []) as Album[];
}

export async function getYtMusicNewReleases(count = 20) {
	const r = await call('getYtMusicNewReleases', { count });
	return (r.albumList2?.album ?? []) as Album[];
}

// Album requests are kept briefly so a press on a card can start the fetch before
// the album page opens (see AlbumCard), and opening it again is instant.
const ALBUM_MEMO_MS = 2 * 60_000;
const albumRequests = new Map<string, { at: number; request: Promise<Album> }>();

export function getAlbum(id: string): Promise<Album> {
	const key = `${session?.base}|${session?.username ?? ''}|${id}`;
	const hit = albumRequests.get(key);
	if (hit && Date.now() - hit.at < ALBUM_MEMO_MS) return hit.request;
	const request = call('getAlbum', { id }).then((r) => r.album as Album);
	albumRequests.set(key, { at: Date.now(), request });
	request.catch(() => albumRequests.delete(key));
	if (albumRequests.size > 50) albumRequests.delete(albumRequests.keys().next().value!);
	return request;
}

export async function getArtists() {
	const r = await call('getArtists');
	const index = (r.artists?.index ?? []) as { name: string; artist?: Artist[] }[];
	return index.flatMap((i) => i.artist ?? []);
}

export async function getArtist(id: string) {
	const r = await call('getArtist', { id });
	return r.artist as Artist;
}

export async function getArtistInfo(id: string) {
	try {
		const r = await call('getArtistInfo2', { id, count: 12 });
		return (r.artistInfo2 ?? {}) as ArtistInfo;
	} catch {
		return {} as ArtistInfo;
	}
}

export async function getTopSongs(artist: string, count = 10) {
	try {
		const r = await call('getTopSongs', { artist, count });
		return (r.topSongs?.song ?? []) as Song[];
	} catch {
		return [];
	}
}

export async function getSimilarSongs(id: string, count = 50) {
	const r = await call('getSimilarSongs2', { id, count });
	return (r.similarSongs2?.song ?? []) as Song[];
}

/**
 * Smart Discover: one YouTube Music radio mix blended from up to five seed tracks,
 * sent as artist/title pairs (the same seeds the main frontend posts to
 * /discover/queue/smart-discover). DroppedNeedle-specific; `artist`/`title` repeat in order.
 */
export async function getSmartDiscover(seeds: { artist: string; title: string }[], count = 15) {
	const r = await call('getSimilarSongs2', {
		artist: seeds.map((s) => s.artist),
		title: seeds.map((s) => s.title),
		count
	});
	return (r.similarSongs2?.song ?? []) as Song[];
}

// Hify extensions: YouTube Music trending chart and Spotify's "Today's Top Hits".
export async function getTrendingSongs(count = 20, country?: string) {
	const r = await call('getTrendingSongs', { count, country });
	return (r.trendingSongs?.song ?? []) as Song[];
}

export async function getTrendingPlaylists(country?: string) {
	const r = await call('getTrendingPlaylists', { country });
	return (r.playlists?.playlist ?? []) as Playlist[];
}

export async function getTodaysHits(count = 20) {
	const r = await call('getTodaysHits', { count });
	return (r.todaysHits?.song ?? []) as Song[];
}

export async function getRandomSongs(size = 50, extra: Params = {}) {
	const r = await call('getRandomSongs', { size, ...extra });
	return (r.randomSongs?.song ?? []) as Song[];
}

export async function getRandomRadioMix(count = 20, force = false) {
	const key = 'cachedRadioMix';
	if (!force) {
		const cached = localStorage.getItem(key);
		if (cached) {
			try {
				const { timestamp, data } = JSON.parse(cached);
				if (Date.now() - timestamp < 24 * 60 * 60 * 1000) {
					return data as Playlist[];
				}
			} catch (e) {
				// ignore
			}
		}
	}
	const r = await call('getRandomRadioMix', { count });
	const data = (r.randomRadioMix?.playlist ?? []) as Playlist[];
	if (data.length > 0) {
		localStorage.setItem(key, JSON.stringify({ timestamp: Date.now(), data }));
	}
	return data;
}

export async function getSongsByGenre(genre: string, count = 100, offset = 0) {
	const r = await call('getSongsByGenre', { genre, count, offset });
	return (r.songsByGenre?.song ?? []) as Song[];
}

export async function getGenres() {
	const r = await call('getGenres');
	return ((r.genres?.genre ?? []) as Genre[]).sort((a, b) => (b.songCount ?? 0) - (a.songCount ?? 0));
}

/** Online catalog the server blends into search results. */
export type SearchSource = 'spotify' | 'ytmusic';

export async function search(
	query: string,
	counts = { artist: 8, album: 10, song: 20, playlist: 10 },
	songOffset = 0,
	localOnly = false,
	source: SearchSource = 'spotify'
) {
	const r = await call('search3', {
		query,
		artistCount: counts.artist,
		albumCount: counts.album,
		songCount: counts.song,
		playlistCount: counts.playlist,
		songOffset,
		localOnly,
		source
	});
	const res = r.searchResult3 ?? {};
	return {
		artists: (res.artist ?? []) as Artist[],
		albums: (res.album ?? []) as Album[],
		songs: (res.song ?? []) as Song[],
		playlists: (res.playlist ?? []) as Playlist[]
	};
}

/** OpenSubsonic allows an empty search3 query to page through every song. */
export async function getAllSongs(offset = 0, count = 100) {
	return (await search('', { artist: 0, album: 0, song: count, playlist: 0 }, offset)).songs;
}

export async function getStarred() {
	const r = await call('getStarred2');
	const s = r.starred2 ?? {};
	return {
		artists: (s.artist ?? []) as Artist[],
		albums: (s.album ?? []) as Album[],
		songs: (s.song ?? []) as Song[]
	};
}

export async function setStarred(kind: 'song' | 'album' | 'artist', id: string, starred: boolean) {
	const key = kind === 'song' ? 'id' : kind === 'album' ? 'albumId' : 'artistId';
	await call(starred ? 'star' : 'unstar', { [key]: id });
}

// ---- Playlists --------------------------------------------------------------

export async function getPlaylists() {
	const r = await call('getPlaylists');
	return (r.playlists?.playlist ?? []) as Playlist[];
}

export async function getPlaylist(id: string) {
	const r = await call('getPlaylist', { id });
	return r.playlist as Playlist;
}

export async function createPlaylist(name: string, songIds: string[] = []) {
	const r = await call('createPlaylist', { name, songId: songIds });
	return r.playlist as Playlist | undefined;
}

export async function addToPlaylist(playlistId: string, songs: Song[]) {
	const songIds = songs.map((song) => song.id);
	await call('updatePlaylist', {
		playlistId,
		songIdToAdd: songIds,
		songTitle: songs.map((song) => song.title),
		songArtist: songs.map((song) => song.displayArtist ?? song.artist ?? ''),
		songAlbum: songs.map((song) => song.album ?? ''),
		songDuration: songs.map((song) => song.duration ?? '')
	});
}

export async function removeFromPlaylist(playlistId: string, indexes: number[]) {
	await call('updatePlaylist', { playlistId, songIndexToRemove: indexes });
}

export async function deletePlaylist(id: string) {
	await call('deletePlaylist', { id });
}

// ---- Account & server -------------------------------------------------------

export interface UserInfo {
	username: string;
	adminRole?: boolean;
	/** DroppedNeedle extension: "admin", "trusted" or "user". */
	role?: string;
	scrobblingEnabled?: boolean;
	maxBitRate?: number;
}

export interface ServerInfo {
	type?: string;
	serverVersion?: string;
	version?: string;
	openSubsonic?: boolean;
}

export interface ScanStatus {
	scanning: boolean;
	count?: number;
}

export async function getServerInfo(): Promise<ServerInfo> {
	const r = await call('ping');
	return { type: r.type, serverVersion: r.serverVersion, version: r.version, openSubsonic: r.openSubsonic };
}

/** Subsonic requires `username`; API-key sessions don't know theirs, and the server answers for the caller anyway. */
export async function getUser(): Promise<UserInfo> {
	const r = await call('getUser', { username: session?.username || 'me' });
	return r.user as UserInfo;
}

export function avatarUrl(username: string) {
	return session ? buildUrl(session, 'getAvatar', { username }) : undefined;
}

export async function getScanStatus(): Promise<ScanStatus> {
	const r = await call('getScanStatus');
	return r.scanStatus as ScanStatus;
}

export async function startScan(): Promise<ScanStatus> {
	const r = await call('startScan');
	return r.scanStatus as ScanStatus;
}

// ---- Server downloads (into the library) ------------------------------------

/**
 * Library items were removed on the server: take them (any object whose `id` is in
 * `ids`) out of every cached answer - in memory, on disk and the pending album
 * requests - so nothing needs refetching. Timestamps are kept, so freshness and
 * revalidation work as before.
 */
async function dropFromCache(ids: ReadonlySet<string>) {
	if (!ids.size) return;
	let changed = false;
	const prune = (value: unknown): unknown => {
		if (Array.isArray(value)) {
			const kept = value.filter((item) => {
				const gone = !!item && typeof item === 'object' && ids.has((item as { id?: string }).id ?? '');
				if (gone) changed = true;
				return !gone;
			});
			return kept.map(prune);
		}
		if (value && typeof value === 'object') {
			const out: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(value)) out[k] = prune(v);
			return out;
		}
		return value;
	};
	// The pruned copy when something was removed, else the original (untouched).
	const pruned = (data: unknown) => {
		changed = false;
		const next = prune(data);
		return changed ? next : data;
	};

	for (const [k, entry] of memo) {
		const data = pruned(entry.data);
		if (data !== entry.data) memo.set(k, { at: entry.at, data });
	}
	for (const [k, hit] of albumRequests) {
		albumRequests.set(k, { at: hit.at, request: hit.request.then((a) => pruned(a) as Album) });
	}
	if (!store) return;
	try {
		for (const [k, entry] of await idbEntries<string, CacheEntry>(store)) {
			const data = pruned(entry.data);
			if (data !== entry.data) await idbSet(k, { at: entry.at, data }, store);
		}
	} catch {
		/* best effort: the next revalidation corrects the disk copy */
	}
}

/** Removes a library song (`tr-` id) and its file. Returns the removed song ids. */
export async function removeLibraryTrack(id: string): Promise<string[]> {
	const r = await call('removeLibraryTrack', { id });
	const removed: string[] = r.libraryRemoval?.removedSongId ?? [];
	void dropFromCache(new Set(removed));
	return removed;
}

/**
 * Removes a library album (`al-` id) and its files. `stopWanted` stops the Wanted
 * watcher looking for a replacement. Returns the removed song ids.
 */
export async function removeLibraryAlbum(id: string, stopWanted = true): Promise<string[]> {
	const r = await call('removeLibraryAlbum', { id, stopWanted });
	const removed: string[] = r.libraryRemoval?.removedSongId ?? [];
	void dropFromCache(new Set([id, ...removed]));
	return removed;
}

/** A Spotify catalog track, offered as the metadata for a server download. */
export interface SpotifyMatch {
	id: string;
	title: string;
	artist: string;
	album: string;
	coverUrl?: string;
	/** Seconds. */
	duration?: number;
}

export async function searchSpotifyTracks(query: string, count = 8): Promise<SpotifyMatch[]> {
	const r = await call('searchSpotifyTracks', { query, count });
	return (r.spotifyTracks?.track ?? []) as SpotifyMatch[];
}

/**
 * Asks the server to download a Spotify track into the library. `id` is a
 * Spotify track id, bare or as an `st-` song id.
 */
export async function requestSpotifyDownload(
	id: string
): Promise<{ status: 'queued' | 'already_in_library'; taskId?: string }> {
	const r = await call('requestSpotifyDownload', { id });
	return r.spotifyDownload;
}

// ---- Last.fm (Hify extension) -----------------------------------------------

export interface LastfmStatus {
	/** The server has a Last.fm app registered; without it nobody can link. */
	available: boolean;
	linked: boolean;
	username?: string;
	/** Plays are sent to Last.fm. */
	scrobbling: boolean;
}

export async function getLastfmStatus(): Promise<LastfmStatus> {
	const r = await call('getLastfmStatus');
	return r.lastfm as LastfmStatus;
}

export async function setLastfmScrobbling(enabled: boolean): Promise<LastfmStatus> {
	const r = await call('setLastfmScrobbling', { enabled });
	return r.lastfm as LastfmStatus;
}

/** Why an item is recommended, e.g. "Similar to Radiohead". */
type Reasoned<T> = T & { reason?: string };

export type LastfmShelf = { key: string; title: string; subtitle?: string } & (
	| { kind: 'artist'; artist: Reasoned<Artist>[] }
	| { kind: 'album'; album: Reasoned<Album>[] }
	| { kind: 'song'; song: Reasoned<Song>[] }
);

export async function getLastfmRecommendations(refresh = false): Promise<LastfmShelf[]> {
	const r = await call('getLastfmRecommendations', refresh ? { refresh } : {});
	return (r.lastfmRecommendations?.shelf ?? []) as LastfmShelf[];
}

// ---- Playback ---------------------------------------------------------------

/**
 * Streamed YouTube (`yt-`) and Spotify (`st-`) tracks — see the backend's
 * subsonic `ids.py`. They aren't library files, so they aren't saved as the
 * server play queue. They are scrobbled: the server names them from the provider.
 */
function isRemoteTrack(id: string | undefined): boolean {
	return !!id && (id.startsWith('yt-') || id.startsWith('st-'));
}

export async function scrobble(id: string, submission: boolean) {
	try {
		await call('scrobble', { id, submission, time: Date.now() });
	} catch {
		/* scrobbling is best-effort */
	}
}

/** Fallback for when am-lyrics finds nothing: plain (unsynced) lyrics from the server. */
export async function getLyrics(song: Song): Promise<Lyrics | null> {
	try {
		const r = await call('getLyrics', { artist: song.artist, title: song.title });
		const text: string | undefined = r.lyrics?.value;
		if (text?.trim()) return { synced: false, lines: text.split(/\r?\n/).map((value) => ({ value })) };
	} catch {
		/* no lyrics */
	}
	return null;
}

/** A karaoke (instrumental) version of `song` found on YouTube, or null when there is none. */
export async function getKaraoke(song: Song): Promise<Song | null> {
	const r = await call('getKaraoke', {
		title: song.title,
		artist: song.artist,
		duration: song.duration
	});
	return (r.karaoke?.song as Song | undefined) ?? null;
}

export async function savePlayQueue(ids: string[], current?: string, position?: number) {
	if (isRemoteTrack(current)) return;
	try {
		if (ids.length) await call('savePlayQueue', { id: ids, current, position });
	} catch {
		/* best-effort */
	}
}

export async function getPlayQueue() {
	try {
		const r = await call('getPlayQueue');
		const q = r.playQueue;
		if (!q?.entry?.length) return null;
		return {
			songs: q.entry as Song[],
			current: q.current as string | undefined,
			position: (q.position ?? 0) as number
		};
	} catch {
		return null;
	}
}
