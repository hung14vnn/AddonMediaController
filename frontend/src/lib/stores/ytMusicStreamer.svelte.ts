import { API } from '$lib/constants';
import type { YTMusicStreamInfo } from '$lib/types';
import type { QueueItem } from '$lib/player/types';
import { api } from '$lib/api/client';
import { playerStore } from '$lib/stores/player.svelte';
import { playbackToast } from '$lib/stores/playbackToast.svelte';
import { openGlobalPlaylistModal } from '$lib/stores/playlistModal.svelte';
import { fetchAlbumTracks } from '$lib/api/albums';
import { compareDiscTrack, normalizeDiscNumber } from '$lib/player/queueHelpers';

export type StreamAction = 'playNow' | 'replaceCurrent' | 'playNext' | 'addToQueue' | 'addToPlaylist';

export interface AlbumTrackInput {
	title: string;
	position: number;
	disc_number?: number | null;
	length?: number | null;
}

export interface StreamAlbumOptions {
	artist: string;
	albumTitle: string;
	albumId?: string;
	coverUrl?: string | null;
	tracks?: AlbumTrackInput[];
	startIndex?: number;
	shuffle?: boolean;
	action?: StreamAction;
	artistId?: string;
}

function createYTMusicStreamer() {
	let activeKey = $state<string | null>(null);
	let status = $state<'idle' | 'loading' | 'playing'>('idle');

	async function streamAlbum(options: StreamAlbumOptions): Promise<QueueItem[] | null> {
		const {
			artist,
			albumTitle,
			albumId,
			coverUrl,
			startIndex = 0,
			shuffle = false,
			action = 'playNow',
			artistId
		} = options;

		const searchKey = `album|${artist}|${albumId ?? albumTitle}`;
		if (status === 'loading' && activeKey === searchKey) return null;

		activeKey = searchKey;
		status = 'loading';

		try {
			let rawTracks = options.tracks;
			if ((!rawTracks || rawTracks.length === 0) && albumId) {
				try {
					const tracksInfo = await fetchAlbumTracks(albumId);
					rawTracks = tracksInfo?.tracks;
				} catch (err) {
					console.warn('Failed to fetch album tracks from API, falling back to single query', err);
				}
			}

			// If still no track list available, fall back to streaming single track query
			if (!rawTracks || rawTracks.length === 0) {
				const single = await streamTrack(artist, albumTitle, action, albumTitle, coverUrl);
				return single ? [single] : null;
			}

			const sortedTracks = [...rawTracks].sort(compareDiscTrack);
			const validIndex = Math.max(0, Math.min(startIndex, sortedTracks.length - 1));
			const startTrack = sortedTracks[validIndex];

			// Resolve start track first for immediate playback
			const info = await api.global.get<YTMusicStreamInfo>(
				API.ytmusicStream.search(artist, startTrack.title)
			);

			const effectiveAlbumId = albumId ?? `ytmusic-album-${info.video_id}`;
			const effectiveCoverUrl = coverUrl ?? info.thumbnail ?? null;

			const queueItems: QueueItem[] = sortedTracks.map((t, i) => {
				const isStart = i === validIndex;
				const videoId = isStart ? info.video_id : '';
				return {
					trackSourceId: videoId,
					trackName: isStart ? (info.title || t.title) : t.title,
					artistName: isStart ? (info.artist || artist) : artist,
					albumName: albumTitle,
					albumId: effectiveAlbumId,
					coverUrl: effectiveCoverUrl,
					sourceType: 'ytmusic',
					streamUrl: isStart ? API.ytmusicStream.stream(info.video_id) : undefined,
					duration: t.length
						? Math.round(t.length / 1000)
						: (isStart ? info.duration_s ?? undefined : undefined),
					availableSources: ['ytmusic'],
					trackNumber: t.position,
					discNumber: normalizeDiscNumber(t.disc_number),
					artistId
				};
			});

			if (action === 'playNow') {
				playerStore.playQueue(queueItems, validIndex, shuffle);
				status = 'playing';
			} else if (action === 'replaceCurrent') {
				if (!playerStore.hasQueue) {
					playerStore.playQueue(queueItems, validIndex, shuffle);
				} else {
					playerStore.replaceCurrentTrack(queueItems[validIndex]);
					const remaining = queueItems.filter((_, idx) => idx !== validIndex);
					if (remaining.length > 0) {
						playerStore.addMultipleToQueue(remaining);
					}
				}
				status = 'playing';
			} else if (action === 'playNext') {
				playerStore.playMultipleNext(queueItems);
				playbackToast.show(`Added "${albumTitle}" to play next`);
				status = 'idle';
			} else if (action === 'addToQueue') {
				playerStore.addMultipleToQueue(queueItems);
				playbackToast.show(`Added "${albumTitle}" to queue`);
				status = 'idle';
			} else if (action === 'addToPlaylist') {
				openGlobalPlaylistModal(queueItems);
				status = 'idle';
			}
			return queueItems;
		} catch (e) {
			console.error('Failed to stream album from YTMusic:', e);
			playbackToast.show(`Could not stream album "${albumTitle}" by ${artist}`, 'error');
			status = 'idle';
			return null;
		}
	}

	async function streamTrack(
		artist: string,
		track: string,
		action: StreamAction = 'playNow',
		album?: string,
		coverUrl?: string | null,
		albumTracks?: AlbumTrackInput[],
		trackIndex?: number,
		albumId?: string
	) {
		if (albumTracks && albumTracks.length > 1) {
			const res = await streamAlbum({
				artist,
				albumTitle: album ?? track,
				albumId,
				coverUrl,
				tracks: albumTracks,
				startIndex: trackIndex ?? 0,
				action
			});
			return res ? res[trackIndex ?? 0] ?? res[0] : null;
		}

		const searchKey = `${artist}|${track}`;
		if (status === 'loading' && activeKey === searchKey) return null;
		
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
		streamTrack,
		streamAlbum
	};
}

export const ytMusicStreamer = createYTMusicStreamer();
