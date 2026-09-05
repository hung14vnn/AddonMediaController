import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockApiGet = vi.hoisted(() => vi.fn());

vi.mock('$lib/api/client', () => ({
	api: { global: { get: mockApiGet } }
}));

import {
	cachePlaybackTrack,
	clearPlaybackCache,
	createPlaybackTrackUrl,
	deletePlaybackTracks,
	PLAYBACK_CACHE_MAX_TRACKS
} from './playbackAudioCache';

const userId = `playback-cache-test-${Date.now()}`;

function input(trackId: string) {
	return {
		userId,
		trackId,
		sourceUrl: `/api/v1/stream/local/${trackId}`,
		format: 'm4a'
	};
}

function audioResponse(contents: string, init?: ResponseInit): Response {
	const body = new Blob([contents], { type: 'audio/mp4' });
	return new Response(body, {
		status: 200,
		headers: {
			'content-type': 'audio/mp4',
			'content-length': String(body.size)
		},
		...init
	});
}

describe('automatic playback audio cache', () => {
	beforeEach(async () => {
		await clearPlaybackCache();
		mockApiGet.mockReset();
		mockApiGet.mockImplementation((url: string) => Promise.resolve(audioResponse(`audio:${url}`)));
	});

	afterEach(async () => {
		await clearPlaybackCache();
	});

	it('pre-downloads once and reuses the cached URL', async () => {
		expect(await cachePlaybackTrack(input('track-1'))).toBe(true);

		const first = await createPlaybackTrackUrl(input('track-1'));
		const second = await createPlaybackTrackUrl(input('track-1'));

		expect(first?.url).toMatch(/^(blob:|.*__hify_audio_cache__)/);
		expect(second?.url).toMatch(/^(blob:|.*__hify_audio_cache__)/);
		expect(first?.source).toBe('cache');
		expect(second?.source).toBe('cache');
		expect(mockApiGet).toHaveBeenCalledTimes(1);
		expect(mockApiGet).toHaveBeenCalledWith(
			'/api/v1/stream/local/track-1',
			expect.objectContaining({ raw: true, cache: 'no-store', signal: expect.any(AbortSignal) })
		);
		first?.revoke();
		second?.revoke();
	});

	it('does not store a partial range response as a complete track', async () => {
		mockApiGet.mockResolvedValue(
			audioResponse('partial', {
				status: 206,
				headers: { 'content-type': 'audio/mp4', 'content-range': 'bytes 0-6/100' }
			})
		);

		expect(await cachePlaybackTrack(input('partial'))).toBe(false);
		expect(await createPlaybackTrackUrl(input('partial'))).toBeNull();
		expect(mockApiGet).toHaveBeenCalledTimes(2);
	});

	it('removes a cached track after its library file is deleted', async () => {
		expect(await cachePlaybackTrack(input('removed'))).toBe(true);
		expect(await deletePlaybackTracks(userId, ['removed'])).toBe(1);

		const downloadedAgain = await createPlaybackTrackUrl(input('removed'));
		expect(downloadedAgain?.url).toMatch(/^(blob:|.*__hify_audio_cache__)/);
		expect(mockApiGet).toHaveBeenCalledTimes(2);
		downloadedAgain?.revoke();
	});

	it('evicts the least-recently-used track when the track limit is exceeded', async () => {
		for (let index = 0; index <= PLAYBACK_CACHE_MAX_TRACKS; index++) {
			expect(await cachePlaybackTrack(input(`lru-${String(index).padStart(2, '0')}`))).toBe(true);
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		expect(mockApiGet).toHaveBeenCalledTimes(PLAYBACK_CACHE_MAX_TRACKS + 1);

		const evicted = await createPlaybackTrackUrl(input('lru-00'));
		expect(evicted?.url).toMatch(/^(blob:|.*__hify_audio_cache__)/);
		expect(mockApiGet).toHaveBeenCalledTimes(PLAYBACK_CACHE_MAX_TRACKS + 2);
		evicted?.revoke();
	});
});
