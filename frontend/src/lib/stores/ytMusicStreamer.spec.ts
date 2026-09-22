import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockApi = vi.hoisted(() => ({
	global: {
		get: vi.fn()
	}
}));

const mockPlayerStore = vi.hoisted(() => ({
	playQueue: vi.fn(),
	replaceCurrentTrack: vi.fn(),
	playNext: vi.fn(),
	addToQueue: vi.fn(),
	playMultipleNext: vi.fn(),
	addMultipleToQueue: vi.fn(),
	hasQueue: false
}));

const mockPlaybackToast = vi.hoisted(() => ({
	show: vi.fn()
}));

const mockOpenGlobalPlaylistModal = vi.hoisted(() => vi.fn());

const mockFetchAlbumTracks = vi.hoisted(() => vi.fn());

vi.mock('$lib/api/client', () => ({
	api: mockApi
}));

vi.mock('$lib/stores/player.svelte', () => ({
	playerStore: mockPlayerStore
}));

vi.mock('$lib/stores/playbackToast.svelte', () => ({
	playbackToast: mockPlaybackToast
}));

vi.mock('$lib/stores/playlistModal.svelte', () => ({
	openGlobalPlaylistModal: mockOpenGlobalPlaylistModal
}));

vi.mock('$lib/api/albums', () => ({
	fetchAlbumTracks: mockFetchAlbumTracks
}));

import { ytMusicStreamer } from './ytMusicStreamer.svelte';

describe('ytMusicStreamer', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockPlayerStore.hasQueue = false;
	});

	describe('streamTrack', () => {
		it('streams a single track and calls playerStore.playQueue with one item', async () => {
			mockApi.global.get.mockResolvedValueOnce({
				video_id: 'vid-1',
				title: 'Come Together',
				artist: 'The Beatles',
				duration_s: 259,
				thumbnail: 'https://img.youtube.com/vi/vid-1/0.jpg'
			});

			const item = await ytMusicStreamer.streamTrack('The Beatles', 'Come Together', 'playNow', 'Abbey Road');

			expect(mockApi.global.get).toHaveBeenCalledWith('/api/v1/stream/ytmusic/search?artist=The%20Beatles&track=Come%20Together');
			expect(mockPlayerStore.playQueue).toHaveBeenCalledOnce();
			expect(mockPlayerStore.playQueue).toHaveBeenCalledWith([item], 0);
			expect(item?.trackSourceId).toBe('vid-1');
			expect(item?.streamUrl).toBe('/api/v1/stream/ytmusic/vid-1');
			expect(item?.albumName).toBe('Abbey Road');
		});
	});

	describe('streamAlbum', () => {
		const sampleTracks = [
			{ title: 'Come Together', position: 1, disc_number: 1, length: 259000 },
			{ title: 'Something', position: 2, disc_number: 1, length: 182000 },
			{ title: 'Maxwell Silver Hammer', position: 3, disc_number: 1, length: 207000 }
		];

		it('queues all tracks in the album and starts at startIndex', async () => {
			mockApi.global.get.mockResolvedValueOnce({
				video_id: 'vid-start',
				title: 'Come Together',
				artist: 'The Beatles',
				duration_s: 259,
				thumbnail: 'https://img.youtube.com/thumb.jpg'
			});

			const items = await ytMusicStreamer.streamAlbum({
				artist: 'The Beatles',
				albumTitle: 'Abbey Road',
				albumId: 'mbid-abbey-road',
				coverUrl: 'https://cover.jpg',
				tracks: sampleTracks,
				startIndex: 0
			});

			expect(mockApi.global.get).toHaveBeenCalledWith('/api/v1/stream/ytmusic/search?artist=The%20Beatles&track=Come%20Together');
			expect(items).toHaveLength(3);
			// Start track has resolved streamUrl and trackSourceId
			expect(items![0].trackSourceId).toBe('vid-start');
			expect(items![0].streamUrl).toBe('/api/v1/stream/ytmusic/vid-start');
			// Other tracks are in the queue ready for lazy resolution
			expect(items![1].trackSourceId).toBe('');
			expect(items![1].trackName).toBe('Something');
			expect(items![1].sourceType).toBe('ytmusic');
			expect(items![2].trackSourceId).toBe('');
			expect(items![2].trackName).toBe('Maxwell Silver Hammer');

			expect(mockPlayerStore.playQueue).toHaveBeenCalledWith(items, 0, false);
		});

		it('fetches tracks from API when only albumId is provided', async () => {
			mockFetchAlbumTracks.mockResolvedValueOnce({
				tracks: sampleTracks
			});

			mockApi.global.get.mockResolvedValueOnce({
				video_id: 'vid-start',
				title: 'Come Together',
				artist: 'The Beatles',
				duration_s: 259
			});

			const items = await ytMusicStreamer.streamAlbum({
				artist: 'The Beatles',
				albumTitle: 'Abbey Road',
				albumId: 'mbid-abbey-road'
			});

			expect(mockFetchAlbumTracks).toHaveBeenCalledWith('mbid-abbey-road');
			expect(items).toHaveLength(3);
			expect(mockPlayerStore.playQueue).toHaveBeenCalledWith(items, 0, false);
		});

		it('handles playNext action for the entire album', async () => {
			mockApi.global.get.mockResolvedValueOnce({
				video_id: 'vid-start',
				title: 'Come Together'
			});

			await ytMusicStreamer.streamAlbum({
				artist: 'The Beatles',
				albumTitle: 'Abbey Road',
				tracks: sampleTracks,
				action: 'playNext'
			});

			expect(mockPlayerStore.playMultipleNext).toHaveBeenCalledOnce();
			expect(mockPlayerStore.playMultipleNext.mock.calls[0][0]).toHaveLength(3);
			expect(mockPlaybackToast.show).toHaveBeenCalledWith('Added "Abbey Road" to play next');
		});

		it('handles addToQueue action for the entire album', async () => {
			mockApi.global.get.mockResolvedValueOnce({
				video_id: 'vid-start',
				title: 'Come Together'
			});

			await ytMusicStreamer.streamAlbum({
				artist: 'The Beatles',
				albumTitle: 'Abbey Road',
				tracks: sampleTracks,
				action: 'addToQueue'
			});

			expect(mockPlayerStore.addMultipleToQueue).toHaveBeenCalledOnce();
			expect(mockPlayerStore.addMultipleToQueue.mock.calls[0][0]).toHaveLength(3);
			expect(mockPlaybackToast.show).toHaveBeenCalledWith('Added "Abbey Road" to queue');
		});

		it('handles addToPlaylist action for the entire album', async () => {
			mockApi.global.get.mockResolvedValueOnce({
				video_id: 'vid-start',
				title: 'Come Together'
			});

			await ytMusicStreamer.streamAlbum({
				artist: 'The Beatles',
				albumTitle: 'Abbey Road',
				tracks: sampleTracks,
				action: 'addToPlaylist'
			});

			expect(mockOpenGlobalPlaylistModal).toHaveBeenCalledOnce();
			expect(mockOpenGlobalPlaylistModal.mock.calls[0][0]).toHaveLength(3);
		});
	});
});
