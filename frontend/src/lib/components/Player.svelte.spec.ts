import { page } from '@vitest/browser/context';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { LyricsData } from '$lib/queries/lyrics/LyricsQuery.svelte';

vi.mock('$env/dynamic/public', () => ({
	env: { PUBLIC_API_URL: '' }
}));

vi.mock('$lib/player/createSource', () => ({
	createPlaybackSource: vi.fn(() => ({
		type: 'local' as const,
		load: vi.fn().mockResolvedValue(undefined),
		play: vi.fn(),
		pause: vi.fn(),
		seekTo: vi.fn(),
		setVolume: vi.fn(),
		getCurrentTime: vi.fn(() => 0),
		getDuration: vi.fn(() => 180),
		isSeekable: vi.fn(() => true),
		destroy: vi.fn(),
		onStateChange: vi.fn(),
		onReady: vi.fn(),
		onError: vi.fn(),
		onProgress: vi.fn()
	}))
}));

let mockQueryState: {
	isSuccess: boolean;
	isError: boolean;
	isLoading: boolean;
	isFetching: boolean;
	data: LyricsData | null | undefined;
};

const { mockOpenPlaylistModal } = vi.hoisted(() => ({
	mockOpenPlaylistModal: vi.fn()
}));

vi.mock('$lib/components/AddToPlaylistModal.svelte', () => ({
	openGlobalPlaylistModal: (...args: unknown[]) => mockOpenPlaylistModal(...args)
}));

vi.mock('$lib/queries/lyrics/LyricsQuery.svelte', () => ({
	getLyricsQuery: vi.fn(() => mockQueryState)
}));

import { playerStore } from '$lib/stores/player.svelte';
import Player from './Player.svelte';

function makeTrack(sourceType: 'navidrome' | 'jellyfin' | 'youtube' | 'local' | 'plex', id = 'v1') {
	return {
		trackSourceId: id,
		trackName: 'Test Track',
		artistName: 'Test Artist',
		trackNumber: 1,
		albumId: 'a1',
		albumName: 'Test Album',
		coverUrl: null,
		sourceType,
		streamUrl: `http://test/${id}.mp3`
	};
}

describe('Player.svelte lyrics button', () => {
	beforeEach(() => {
		playerStore.stop();
		mockOpenPlaylistModal.mockReset();
		mockQueryState = {
			isSuccess: false,
			isError: false,
			isLoading: false,
			isFetching: false,
			data: undefined
		};
	});

	it('opens add-to-playlist for the current local track', async () => {
		const track = makeTrack('local');
		playerStore.playQueue([track]);
		render(Player);

		await page.getByLabelText('Add current track to playlist').click();
		expect(mockOpenPlaylistModal).toHaveBeenCalledWith([track]);
	});

	it('shows lyrics button when query succeeds with lyrics data', async () => {
		mockQueryState = {
			isSuccess: true,
			isError: false,
			isLoading: false,
			isFetching: false,
			data: { text: 'Hello world', is_synced: false, lines: [] }
		};

		playerStore.playQueue([makeTrack('navidrome')]);
		render(Player);

		await expect.element(page.getByLabelText('Toggle lyrics')).toBeInTheDocument();
	});

	it('does not mount the lyrics engine until the lyrics panel is opened', async () => {
		playerStore.playQueue([makeTrack('navidrome')]);
		render(Player);

		await expect.element(page.getByRole('dialog', { name: 'Lyrics' })).not.toBeInTheDocument();

		await page.getByLabelText('Toggle lyrics').click();
		await expect.element(page.getByRole('dialog', { name: 'Lyrics' })).toBeInTheDocument();
	});

	it('keeps word-synced lyrics available when library lyrics are missing', async () => {
		mockQueryState = {
			isSuccess: true,
			isError: false,
			isLoading: false,
			isFetching: false,
			data: null
		};

		playerStore.playQueue([makeTrack('navidrome')]);
		render(Player);

		await expect.element(page.getByLabelText('Toggle lyrics')).toBeEnabled();
	});

	it('keeps word-synced lyrics available while library lyrics load', async () => {
		mockQueryState = {
			isSuccess: false,
			isError: false,
			isLoading: true,
			isFetching: true,
			data: undefined
		};

		playerStore.playQueue([makeTrack('navidrome')]);
		render(Player);

		await expect.element(page.getByLabelText('Toggle lyrics')).toBeEnabled();
	});

	it('keeps word-synced lyrics available when the library query errors', async () => {
		mockQueryState = {
			isSuccess: false,
			isError: true,
			isLoading: false,
			isFetching: false,
			data: undefined
		};

		playerStore.playQueue([makeTrack('navidrome')]);
		render(Player);

		await expect.element(page.getByLabelText('Toggle lyrics')).toBeEnabled();
	});

	it('offers word-synced lyrics for a YouTube track', async () => {
		mockQueryState = {
			isSuccess: false,
			isError: false,
			isLoading: false,
			isFetching: false,
			data: undefined
		};

		playerStore.playQueue([makeTrack('youtube')]);
		render(Player);

		await expect.element(page.getByLabelText('Toggle lyrics')).toBeEnabled();
	});

	it('offers word-synced lyrics for a Plex track', async () => {
		mockQueryState = {
			isSuccess: false,
			isError: false,
			isLoading: false,
			isFetching: false,
			data: undefined
		};

		playerStore.playQueue([makeTrack('plex')]);
		render(Player);

		await expect.element(page.getByLabelText('Toggle lyrics')).toBeEnabled();
	});

	it('shows lyrics button for local source when embedded lyrics exist', async () => {
		mockQueryState = {
			isSuccess: true,
			isError: false,
			isLoading: false,
			isFetching: false,
			data: { text: 'Embedded lyrics', is_synced: false, lines: [] }
		};

		playerStore.playQueue([makeTrack('local')]);
		render(Player);

		await expect.element(page.getByLabelText('Toggle lyrics')).toBeInTheDocument();
	});

	it('offers karaoke for a local queue track', async () => {
		playerStore.playQueue([makeTrack('local')]);
		render(Player);

		await expect.element(page.getByLabelText('Start karaoke')).toBeInTheDocument();
	});

	it('does not offer karaoke for a remote track', async () => {
		playerStore.playQueue([makeTrack('navidrome')]);
		render(Player);

		await expect.element(page.getByLabelText('Start karaoke')).not.toBeInTheDocument();
	});
});
