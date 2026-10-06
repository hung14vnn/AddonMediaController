import { SvelteSet } from 'svelte/reactivity';
import { addToPlaylist, cached, createPlaylist, getPlaylists, getUser, setStarred, type UserInfo } from './api';
import type { Album, Artist, Playlist, Song } from './types';

export interface MenuItem {
	label: string;
	icon?: string;
	danger?: boolean;
	action: () => void;
}

export type LibraryRemoval =
	| { kind: 'track'; song: Song }
	| { kind: 'album'; album: Album };

class UI {
	/** Full-screen Now Playing sheet. */
	nowPlaying = $state(false);
	/** Side panel next to the Now Playing art (desktop) or replacing it (mobile). */
	panel = $state<'lyrics' | 'queue' | null>(null);
	menu = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);
	toast = $state<string | null>(null);
	sleepTimerPicker = $state(false);
	playlistPicker = $state<Song[] | null>(null);
	/** A YouTube song waiting for the Spotify match whose metadata the server downloads it with. */
	spotifyPicker = $state<Song | null>(null);
	/** Library item waiting for the user to confirm its removal (see Overlays). */
	removal = $state<LibraryRemoval | null>(null);
	/** Removed from the library this session: lists hide them without refetching. */
	removedSongs = new SvelteSet<string>();
	removedAlbums = new SvelteSet<string>();
	playlists = $state<Playlist[]>([]);
	/** Optimistic love state keyed by id, layered over what the server returned. */
	loved = $state<Record<string, boolean>>({});
	me = $state<UserInfo | null>(null);

	private toastTimer: ReturnType<typeof setTimeout> | undefined;

	openNowPlaying() {
		if (this.nowPlaying) return;
		history.pushState({ ...history.state, nowPlaying: true }, '', location.href);
		this.nowPlaying = true;
	}

	closeNowPlaying(fromHistory = false) {
		if (!this.nowPlaying) return;
		this.nowPlaying = false;
		this.panel = null;
		if (!fromHistory && history.state?.nowPlaying) history.back();
	}

	showToast(message: string) {
		this.toast = message;
		clearTimeout(this.toastTimer);
		this.toastTimer = setTimeout(() => (this.toast = null), 2200);
	}

	async openMenu(event: MouseEvent, itemsPromise: Promise<MenuItem[]> | MenuItem[]) {
		event.preventDefault();
		event.stopPropagation();
		const target = event.currentTarget as HTMLElement | null;
		const r = target?.getBoundingClientRect();
		const clientX = event.clientX;
		const clientY = event.clientY;
		
		const items = await itemsPromise;

		// Keyboard/tap activations have no pointer position; anchor to the button.
		if (clientX === 0 && clientY === 0 && r) {
			this.menu = { x: r.right, y: r.bottom, items };
		} else {
			this.menu = { x: clientX, y: clientY, items };
		}
	}

	togglePanel(panel: 'lyrics' | 'queue') {
		this.panel = this.panel === panel ? null : panel;
		this.openNowPlaying();
	}

	/** Same gates as the web UI: tracks for admin/trusted, whole albums for admin. */
	get canRemoveTracks() {
		const role = this.me?.role;
		return role ? role === 'admin' || role === 'trusted' : !!this.me?.adminRole;
	}

	get canRemoveAlbums() {
		const role = this.me?.role;
		return role ? role === 'admin' : !!this.me?.adminRole;
	}

	isLoved(item: { id: string; starred?: string }) {
		return this.loved[item.id] ?? !!item.starred;
	}

	async toggleLove(kind: 'song' | 'album' | 'artist', item: Song | Album | Artist) {
		const next = !this.isLoved(item);
		this.loved[item.id] = next;
		try {
			await setStarred(kind, item.id, next);
			this.showToast(next ? 'Added to Favorites' : 'Removed from Favorites');
		} catch {
			this.loved[item.id] = !next;
			this.showToast('Couldn’t update Favorites');
		}
	}

	async loadMe() {
		try {
			this.me = await getUser();
		} catch {
			/* profile info is non-essential */
		}
	}

	async refreshPlaylists() {
		try {
			this.playlists = await cached('playlists', getPlaylists, {
				fresh: 0,
				refresh: (p) => (this.playlists = p)
			});
		} catch {
			/* keep previous list */
		}
	}

	async addSongsToPlaylist(playlist: Playlist, songs: Song[]) {
		try {
			await addToPlaylist(playlist.id, songs);
			this.showToast(`Added to “${playlist.name}”`);
			this.refreshPlaylists();
		} catch {
			this.showToast('Couldn’t add to playlist');
		}
	}

	async createPlaylistWith(name: string, songs: Song[]) {
		try {
			await createPlaylist(
				name,
				songs.map((s) => s.id)
			);
			this.showToast(`Created “${name}”`);
			await this.refreshPlaylists();
		} catch {
			this.showToast('Couldn’t create playlist');
		}
	}
}

export const ui = new UI();
