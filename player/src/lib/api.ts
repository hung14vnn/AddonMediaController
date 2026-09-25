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
	try {
		localStorage.removeItem(STORAGE_KEY);
	} catch {
		/* storage unavailable */
	}
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call<T = any>(endpoint: string, params: Params = {}, s: Session | null = session): Promise<T> {
	if (!s) throw new SubsonicError(10, 'Not signed in');
	const res = await fetch(buildUrl(s, endpoint, params));
	let body;
	try {
		body = await res.json();
	} catch {
		throw new SubsonicError(0, `Server returned ${res.status} (not a Subsonic endpoint?)`);
	}
	const r = body?.['subsonic-response'];
	if (!r) throw new SubsonicError(0, 'Unexpected response from server');
	if (r.status !== 'ok') throw new SubsonicError(r.error?.code ?? 0, r.error?.message ?? 'Request failed');
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
export function optional<T>(p: Promise<T[]>): Promise<T[]> {
	return p.catch(() => []);
}

// ---- Library ----------------------------------------------------------------

export async function getAlbumList(type: AlbumListType, size = 30, offset = 0, extra: Params = {}) {
	const r = await call('getAlbumList2', { type, size, offset, ...extra });
	return (r.albumList2?.album ?? []) as Album[];
}

export async function getAlbum(id: string) {
	const r = await call('getAlbum', { id });
	return r.album as Album;
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

export async function getTodaysHits(count = 20) {
	const r = await call('getTodaysHits', { count });
	return (r.todaysHits?.song ?? []) as Song[];
}

export async function getRandomSongs(size = 50, extra: Params = {}) {
	const r = await call('getRandomSongs', { size, ...extra });
	return (r.randomSongs?.song ?? []) as Song[];
}

export async function getSongsByGenre(genre: string, count = 100, offset = 0) {
	const r = await call('getSongsByGenre', { genre, count, offset });
	return (r.songsByGenre?.song ?? []) as Song[];
}

export async function getGenres() {
	const r = await call('getGenres');
	return ((r.genres?.genre ?? []) as Genre[]).sort((a, b) => (b.songCount ?? 0) - (a.songCount ?? 0));
}

export async function search(query: string, counts = { artist: 8, album: 12, song: 20 }, songOffset = 0) {
	const r = await call('search3', {
		query,
		artistCount: counts.artist,
		albumCount: counts.album,
		songCount: counts.song,
		songOffset
	});
	const res = r.searchResult3 ?? {};
	return {
		artists: (res.artist ?? []) as Artist[],
		albums: (res.album ?? []) as Album[],
		songs: (res.song ?? []) as Song[]
	};
}

/** OpenSubsonic allows an empty search3 query to page through every song. */
export async function getAllSongs(offset = 0, count = 100) {
	return (await search('', { artist: 0, album: 0, song: count }, offset)).songs;
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

export async function addToPlaylist(playlistId: string, songIds: string[]) {
	await call('updatePlaylist', { playlistId, songIdToAdd: songIds });
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

// ---- Playback ---------------------------------------------------------------

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

export async function savePlayQueue(ids: string[], current?: string, position?: number) {
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
