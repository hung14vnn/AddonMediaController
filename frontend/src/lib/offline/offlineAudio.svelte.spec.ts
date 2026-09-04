import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockApiGet = vi.hoisted(() => vi.fn());
const mockApiPost = vi.hoisted(() => vi.fn());

vi.mock('$lib/api/client', () => ({
	api: { global: { get: mockApiGet, post: mockApiPost } }
}));

import {
	deleteAllOfflineTracks,
	deleteOfflineTrack,
	deleteOfflineTracks,
	downloadOfflineTrack,
	findInvalidOfflineTrackIds,
	getOfflineTrackBlob,
	getOfflineTrackMetadata,
	createOfflineTrackUrl
} from './offlineAudio';

const userId = `offline-test-${Date.now()}`;
const otherUserId = `${userId}-other`;
const trackId = 'track-1';

describe('offline audio storage', () => {
	beforeEach(async () => {
		await deleteOfflineTrack(userId, trackId);
		mockApiGet.mockReset();
		mockApiPost.mockReset();
	});

	afterEach(async () => {
		await Promise.all([deleteAllOfflineTracks(userId), deleteAllOfflineTracks(otherUserId)]);
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

	it('marks an object URL from an offline download as downloaded', async () => {
		const body = new Blob(['offline audio'], { type: 'audio/mpeg' });
		mockApiGet.mockResolvedValue(new Response(body, { status: 200 }));
		await downloadOfflineTrack({
			userId,
			trackId,
			sourceUrl: '/stream/track-1',
			title: 'Track 1',
			artistName: 'Artist',
			albumName: 'Album',
			format: 'mp3'
		});

		const url = await createOfflineTrackUrl(userId, trackId);
		expect(url?.url).toMatch(/^blob:/);
		expect(url?.source).toBe('download');
		url?.revoke();
	});

	it("deletes a selected group without touching another user's offline tracks", async () => {
		mockApiGet.mockImplementation((url: string) =>
			Promise.resolve(new Response(new Blob([url]), { status: 200 }))
		);
		for (const [owner, id] of [
			[userId, 'one'],
			[userId, 'two'],
			[otherUserId, 'other']
		] as const) {
			await downloadOfflineTrack({
				userId: owner,
				trackId: id,
				sourceUrl: `/stream/${id}`,
				title: id,
				artistName: 'Artist',
				albumName: 'Album',
				format: 'm4a'
			});
		}

		expect(await deleteOfflineTracks(userId, ['one'])).toBe(1);
		expect(await getOfflineTrackBlob(userId, 'one')).toBeNull();
		expect(await getOfflineTrackBlob(userId, 'two')).not.toBeNull();
		expect(await getOfflineTrackBlob(otherUserId, 'other')).not.toBeNull();

		expect(await deleteAllOfflineTracks(userId)).toBe(1);
		expect(await getOfflineTrackBlob(userId, 'two')).toBeNull();
		expect(await getOfflineTrackBlob(otherUserId, 'other')).not.toBeNull();
		await deleteAllOfflineTracks(otherUserId);
	});

	it('finds offline tracks that no longer exist in the server library', async () => {
		mockApiGet.mockImplementation((url: string) =>
			Promise.resolve(new Response(new Blob([url]), { status: 200 }))
		);
		for (const id of ['still-here', 'removed']) {
			await downloadOfflineTrack({
				userId,
				trackId: id,
				sourceUrl: `/stream/${id}`,
				title: id,
				artistName: 'Artist',
				albumName: 'Album',
				format: 'm4a'
			});
		}
		mockApiPost.mockResolvedValue({ existing_file_ids: ['still-here'] });

		await expect(findInvalidOfflineTrackIds(userId)).resolves.toEqual(['removed']);
		expect(mockApiPost).toHaveBeenCalledWith('/api/v1/library/tracks/existence', {
			file_ids: expect.arrayContaining(['still-here', 'removed'])
		});
	});
});
