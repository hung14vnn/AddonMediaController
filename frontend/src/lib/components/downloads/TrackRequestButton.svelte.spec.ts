import { page } from '@vitest/browser/context';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';

const h = vi.hoisted(() => ({ mutate: vi.fn(), spotifyMutate: vi.fn(), pending: false }));

vi.mock('$lib/queries/downloads/DownloadMutations.svelte', () => ({
	requestTrack: () => ({
		mutate: h.mutate,
		get isPending() {
			return h.pending;
		}
	}),
	requestSpotifyTrack: () => ({
		mutate: h.spotifyMutate,
		get isPending() {
			return h.pending;
		}
	})
}));

import TrackRequestButton from './TrackRequestButton.svelte';

const base = {
	recordingMbid: 'rec',
	trackTitle: 'Airbag',
	artistName: 'Radiohead',
	albumMbid: 'rg'
};
function renderButton(overrides: Record<string, unknown> = {}) {
	return render(TrackRequestButton, { props: { ...base, ...overrides } } as Parameters<
		typeof render<typeof TrackRequestButton>
	>[1]);
}

describe('TrackRequestButton.svelte', () => {
	beforeEach(() => {
		h.mutate = vi.fn();
		h.spotifyMutate = vi.fn();
		h.pending = false;
	});

	it('renders an accessible per-track request button', async () => {
		renderButton();
		await expect.element(page.getByRole('button', { name: 'Request this track' })).toBeVisible();
	});

	it('fires requestTrack on click', async () => {
		renderButton();
		await page.getByRole('button', { name: 'Request this track' }).click();
		expect(h.mutate).toHaveBeenCalled();
	});

	it('uses the Spotify request endpoint for Spotify track URIs', async () => {
		renderButton({ recordingMbid: 'spotify:track:5UQ3JrA9kEh7rfwhUS1h0z' });
		await page.getByRole('button', { name: 'Request this track' }).click();

		expect(h.spotifyMutate).toHaveBeenCalledWith('5UQ3JrA9kEh7rfwhUS1h0z', {
			onSuccess: expect.any(Function)
		});
		expect(h.mutate).not.toHaveBeenCalled();
	});

	it('sends the displayed selected edition as release_id in the exact-track mutation', async () => {
		renderButton({ releaseMbid: 'release-20' });
		await page.getByRole('button', { name: 'Request this track' }).click();
		expect(h.mutate).toHaveBeenCalledTimes(1);
		expect(h.mutate.mock.calls[0][0]).toMatchObject({
			recording_mbid: 'rec',
			release_group_mbid: 'rg',
			release_id: 'release-20'
		});
	});

	it('keeps release_id null when no edition is selected', async () => {
		renderButton();
		await page.getByRole('button', { name: 'Request this track' }).click();
		expect(h.mutate).toHaveBeenCalledTimes(1);
		expect(h.mutate.mock.calls[0][0].release_id).toBeNull();
	});
});
