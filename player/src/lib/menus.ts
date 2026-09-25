import { getAlbum, getPlaylist, getSimilarSongs } from './api';
import { getPlayer } from './player.svelte';
import { router } from './router.svelte';
import type { Album, Playlist, Song } from './types';
import { ui, type MenuItem } from './ui.svelte';

export async function startStation(song: Song) {
	try {
		const similar = await getSimilarSongs(song.id);
		getPlayer().playList([song, ...similar.filter((s) => s.id !== song.id)]);
		ui.showToast(`Station from “${song.title}”`);
	} catch {
		ui.showToast('Couldn’t start a station');
	}
}

import { getSession } from './api';
import { deleteOfflineTrack, downloadOfflineTrack, getOfflineTrackMetadata } from './offline';

export async function songMenu(song: Song, extra: MenuItem[] = []): Promise<MenuItem[]> {
	const player = getPlayer();
	const session = getSession();
	const isDownloaded = session?.username ? !!(await getOfflineTrackMetadata(session.username, song.id)) : false;

	const items: MenuItem[] = [
		{ label: 'Play Next', icon: 'playNext', action: () => player.playNext([song]) },
		{ label: 'Play Last', icon: 'queue', action: () => player.addToQueue([song]) },
		{ label: 'Add to Playlist…', icon: 'playlist', action: () => (ui.playlistPicker = [song]) },
		{
			label: isDownloaded ? 'Remove Download' : 'Download',
			icon: 'download',
			action: async () => {
				if (!session?.username) return;
				if (isDownloaded) {
					await deleteOfflineTrack(session.username, song.id);
					ui.showToast('Removed from Downloads');
				} else {
					ui.showToast('Downloading…');
					try {
						await downloadOfflineTrack(song);
						ui.showToast('Downloaded successfully');
					} catch (e: any) {
						ui.showToast(e.message || 'Download failed');
					}
				}
			}
		},
		{
			label: ui.isLoved(song) ? 'Undo Favorite' : 'Favorite',
			icon: ui.isLoved(song) ? 'starFill' : 'star',
			action: () => ui.toggleLove('song', song)
		},
		{ label: 'Create Station', icon: 'radio', action: () => startStation(song) },
		{ label: 'Sleep Timer', icon: 'clock', action: () => (ui.sleepTimerPicker = true) }
	];
	if (song.albumId) items.push({ label: 'Go to Album', icon: 'album', action: () => router.go(`/album/${song.albumId}`) });
	if (song.artistId) items.push({ label: 'Go to Artist', icon: 'mic', action: () => router.go(`/artist/${song.artistId}`) });
	return [...items, ...extra];
}

async function albumSongs(album: Album) {
	return album.song ?? (await getAlbum(album.id)).song ?? [];
}

export function albumMenu(album: Album): MenuItem[] {
	const player = getPlayer();
	return [
		{ label: 'Play', icon: 'play', action: async () => player.playList(await albumSongs(album)) },
		{ label: 'Shuffle', icon: 'shuffle', action: async () => player.playList(await albumSongs(album), 0, { shuffle: true }) },
		{ label: 'Play Next', icon: 'playNext', action: async () => player.playNext(await albumSongs(album)) },
		{ label: 'Play Last', icon: 'queue', action: async () => player.addToQueue(await albumSongs(album)) },
		{ label: 'Add to Playlist…', icon: 'playlist', action: async () => (ui.playlistPicker = await albumSongs(album)) },
		{
			label: ui.isLoved(album) ? 'Undo Favorite' : 'Favorite',
			icon: ui.isLoved(album) ? 'starFill' : 'star',
			action: () => ui.toggleLove('album', album)
		},
		...(album.artistId
			? [{ label: 'Go to Artist', icon: 'mic', action: () => router.go(`/artist/${album.artistId}`) }]
			: [])
	];
}

export async function playlistSongs(playlist: Playlist) {
	return playlist.entry ?? (await getPlaylist(playlist.id)).entry ?? [];
}

export function playlistMenu(playlist: Playlist): MenuItem[] {
	const player = getPlayer();
	return [
		{ label: 'Play', icon: 'play', action: async () => player.playList(await playlistSongs(playlist)) },
		{
			label: 'Shuffle',
			icon: 'shuffle',
			action: async () => player.playList(await playlistSongs(playlist), 0, { shuffle: true })
		},
		{ label: 'Play Next', icon: 'playNext', action: async () => player.playNext(await playlistSongs(playlist)) },
		{ label: 'Play Last', icon: 'queue', action: async () => player.addToQueue(await playlistSongs(playlist)) }
	];
}
