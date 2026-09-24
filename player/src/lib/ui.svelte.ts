import { addToPlaylist, createPlaylist, getPlaylists, getUser, setStarred, type UserInfo } from './api';
import type { Album, Artist, Playlist, Song } from './types';

export interface MenuItem {
	label: string;
	icon?: string;
	danger?: boolean;
	action: () => void;
}

class UI {
	/** Full-screen Now Playing sheet. */
	nowPlaying = $state(false);
	/** Side panel next to the Now Playing art (desktop) or replacing it (mobile). */
	panel = $state<'lyrics' | 'queue' | null>(null);
	menu = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);
	toast = $state<string | null>(null);
	playlistPicker = $state<Song[] | null>(null);
	playlists = $state<Playlist[]>([]);
	/** Optimistic love state keyed by id, layered over what the server returned. */
	loved = $state<Record<string, boolean>>({});
	me = $state<UserInfo | null>(null);

	private toastTimer: ReturnType<typeof setTimeout> | undefined;

	showToast(message: string) {
		this.toast = message;
		clearTimeout(this.toastTimer);
		this.toastTimer = setTimeout(() => (this.toast = null), 2200);
	}

	openMenu(event: MouseEvent, items: MenuItem[]) {
		event.preventDefault();
		event.stopPropagation();
		const target = event.currentTarget as HTMLElement | null;
		// Keyboard/tap activations have no pointer position; anchor to the button.
		if (event.clientX === 0 && event.clientY === 0 && target) {
			const r = target.getBoundingClientRect();
			this.menu = { x: r.right, y: r.bottom, items };
		} else {
			this.menu = { x: event.clientX, y: event.clientY, items };
		}
	}

	togglePanel(panel: 'lyrics' | 'queue') {
		this.panel = this.panel === panel ? null : panel;
		this.nowPlaying = true;
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
			this.playlists = await getPlaylists();
		} catch {
			/* keep previous list */
		}
	}

	async addSongsToPlaylist(playlist: Playlist, songs: Song[]) {
		try {
			await addToPlaylist(
				playlist.id,
				songs.map((s) => s.id)
			);
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
