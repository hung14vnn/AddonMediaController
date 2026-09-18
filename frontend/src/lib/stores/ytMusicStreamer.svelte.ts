import { API } from '$lib/constants';
import type { YTMusicStreamInfo } from '$lib/types';
import type { QueueItem } from '$lib/player/types';
import { api } from '$lib/api/client';
import { playerStore } from '$lib/stores/player.svelte';
import { playbackToast } from '$lib/stores/playbackToast.svelte';
import { openGlobalPlaylistModal } from '$lib/stores/playlistModal.svelte';

function createYTMusicStreamer() {
	let activeKey = $state<string | null>(null);
	let status = $state<'idle' | 'loading' | 'playing'>('idle');

	async function streamTrack(
		artist: string,
		track: string,
		action: 'playNow' | 'replaceCurrent' | 'playNext' | 'addToQueue' | 'addToPlaylist' = 'playNow',
		album?: string,
		coverUrl?: string | null
	) {
		const searchKey = `${artist}|${track}`;
		if (status === 'loading' && activeKey === searchKey) return;
		
		activeKey = searchKey;
		status = 'loading';

		try {
			const info = await api.global.get<YTMusicStreamInfo>(API.ytmusicStream.search(artist, track));
			
			const queueItem: QueueItem = {
				trackSourceId: info.video_id,
				trackName: info.title || track,
				artistName: info.artist || artist,
				albumName: album ?? 'YouTube Music',
				albumId: `ytmusic-${info.video_id}`,
				coverUrl: coverUrl ?? info.thumbnail ?? null,
				sourceType: 'ytmusic',
				streamUrl: API.ytmusicStream.stream(info.video_id),
				duration: info.duration_s ?? undefined,
				availableSources: ['ytmusic'],
				trackNumber: 1
			};

			if (action === 'playNow') {
				playerStore.playQueue([queueItem], 0);
				status = 'playing';
			} else if (action === 'replaceCurrent') {
				playerStore.replaceCurrentTrack(queueItem);
				status = 'playing';
			} else if (action === 'playNext') {
				playerStore.playNext(queueItem);
				playbackToast.show(`Added "${queueItem.trackName}" to play next`);
				status = 'idle';
			} else if (action === 'addToQueue') {
				playerStore.addToQueue(queueItem);
				playbackToast.show(`Added "${queueItem.trackName}" to queue`);
				status = 'idle';
			} else if (action === 'addToPlaylist') {
				openGlobalPlaylistModal([queueItem]);
				status = 'idle';
			}
			return queueItem;
		} catch (e) {
			console.error('Failed to stream from YTMusic:', e);
			playbackToast.show(`Could not find a stream for "${track}" by ${artist}`, 'error');
			status = 'idle';
			return null;
		}
	}

	return {
		get activeKey() {
			return activeKey;
		},
		get status() {
			return status;
		},
		streamTrack
	};
}

export const ytMusicStreamer = createYTMusicStreamer();
