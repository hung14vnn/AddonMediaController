import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockApiGet = vi.hoisted(() => vi.fn());

vi.mock('$lib/api/client', () => ({
	api: { global: { get: mockApiGet } }
}));

import {
	deleteOfflineTrack,
	downloadOfflineTrack,
	getOfflineTrackBlob,
	getOfflineTrackMetadata
} from './offlineAudio';

const userId = `offline-test-${Date.now()}`;
const trackId = 'track-1';

describe('offline audio storage', () => {
	beforeEach(async () => {
		await deleteOfflineTrack(userId, trackId);
		mockApiGet.mockReset();
	});

	afterEach(async () => {
		await deleteOfflineTrack(userId, trackId);
	});

	it('stores the audio blob and user-scoped metadata', async () => {
		const body = new Blob(['offline audio'], { type: 'audio/mpeg' });
		mockApiGet.mockResolvedValue(
			new Response(body, {
				status: 200,
				headers: { 'content-type': 'audio/mpeg' }
			})
		);

		const metadata = await downloadOfflineTrack({
			userId,
			trackId,
			sourceUrl: '/api/v1/stream/local/track-1',
			title: 'Track 1',
			artistName: 'Artist',
			albumName: 'Album',
			format: 'mp3',
			durationSeconds: 180
		});

		expect(metadata.trackId).toBe(trackId);
		expect(metadata.sizeBytes).toBe(body.size);
		expect(await getOfflineTrackMetadata(userId, trackId)).toEqual(metadata);
		expect(await (await getOfflineTrackBlob(userId, trackId))?.text()).toBe('offline audio');
		expect(mockApiGet).toHaveBeenCalledWith(
			'/api/v1/stream/local/track-1',
			expect.objectContaining({ raw: true })
		);
	});
});
