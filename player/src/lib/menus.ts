import { getAlbum, getPlaylist, getSimilarSongs, requestSpotifyDownload } from './api';
import { getPlayer } from './player.svelte';
import { router } from './router.svelte';
import type { Album, Artist, Playlist, Song } from './types';
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
import { deleteOfflineTrack, downloadOfflineTrack, downloadOfflineTracks, getOfflineTrackMetadata } from './offline';

/**
 * Asks the server to download a song into the library. Spotify songs carry their
 * own metadata and go straight away; a YouTube result first needs a Spotify
 * match picked (see the picker in Overlays), whose metadata the server uses.
 */
export function addToLibrary(song: Song) {
	if (song.id.startsWith('yt-')) ui.spotifyPicker = song;
	else if (song.id.startsWith('st-')) void requestDownload(song.id);
}

export async function requestDownload(spotifyId: string) {
	ui.showToast('Requesting download…');
	try {
		const r = await requestSpotifyDownload(spotifyId);
		ui.showToast(r.status === 'already_in_library' ? 'Already in your library' : 'Added to downloads');
	} catch (e) {
		ui.showToast(e instanceof Error && e.message ? e.message : 'Couldn’t request download');
	}
}

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
		...(song.id.startsWith('yt-') || song.id.startsWith('st-')
			? [{ label: 'Request track to Library', icon: 'server', action: () => addToLibrary(song) }]
			: []),
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

export function artistMenu(artist: Artist, songs: Song[] = []): MenuItem[] {
	const player = getPlayer();
	return [
		{ label: 'Play', icon: 'play', action: () => player.playList(songs) },
		{ label: 'Shuffle', icon: 'shuffle', action: () => player.playList(songs, 0, { shuffle: true }) },
		{ label: ui.isLoved(artist) ? 'Undo Favorite' : 'Favorite', icon: ui.isLoved(artist) ? 'starFill' : 'star', action: () => ui.toggleLove('artist', artist) },
		...(songs[0] ? [{ label: 'Create Station', icon: 'radio', action: () => startStation(songs[0]) }] : [])
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
		{ label: 'Play Last', icon: 'queue', action: async () => player.addToQueue(await playlistSongs(playlist)) },
		{ label: 'Download Playlist', icon: 'download', action: async () => downloadAll(await playlistSongs(playlist)) }
	];
}

const downloading = new Set<string>();

/** Downloads a whole list for offline use, reporting progress through toasts. */
export async function downloadAll(songs: Song[]) {
	const key = songs.map((s) => s.id).join(',');
	if (!songs.length || downloading.has(key)) return;
	downloading.add(key);
	try {
		ui.showToast('Preparing download…');
		const r = await downloadOfflineTracks(songs, (done, total) => ui.showToast(`Downloading ${done}/${total}…`));
		if (r.outOfSpace) ui.showToast(`Out of storage — downloaded ${r.downloaded} songs`);
		else if (r.failed) ui.showToast(`Downloaded ${r.downloaded}, ${r.failed} failed`);
		else if (!r.downloaded) ui.showToast('Already downloaded');
		else ui.showToast(`Downloaded ${r.downloaded} songs`);
	} catch (e) {
		ui.showToast(e instanceof Error ? e.message : 'Download failed');
	} finally {
		downloading.delete(key);
	}
}
