import '../../../app.css';
import { page } from '@vitest/browser/context';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { NativeTrackListItem } from '$lib/types';

const LOCAL_ALBUM_ID = '11111111-1111-4111-8111-111111111111';
const PROVIDER_RG_MBID = '22222222-2222-4222-8222-222222222222';
const LOCAL_ONLY_ALBUM_ID = '33333333-3333-4333-8333-333333333333';

const h = vi.hoisted(() => ({
	get: vi.fn(),
	post: vi.fn(),
	toast: vi.fn(),
	isAdmin: false,
	goto: vi.fn()
}));

vi.mock('$app/navigation', () => ({ goto: h.goto }));
vi.mock('$lib/api/client', () => ({
	api: { global: { get: h.get, post: h.post } },
	ApiError: class ApiError extends Error {}
}));

vi.mock('$lib/queries/library/LibraryMutations.svelte', () => ({
	removeLibraryTrack: () => ({ isPending: false }),
	removeLibraryTracks: () => ({ isPending: false })
}));
vi.mock('$lib/stores/authStore.svelte', () => ({
	authStore: {
		get isAdmin() {
			return h.isAdmin;
		},
		user: { id: 'test-user' }
	}
}));
vi.mock('$lib/stores/toast', () => ({ toastStore: { show: h.toast } }));

import TracksPage from './+page.svelte';

function makeTrack(overrides: Partial<NativeTrackListItem>): NativeTrackListItem {
	return {
		id: 'track-1',
		title: 'Identified Track',
		album_id: LOCAL_ALBUM_ID,
		album_title: 'Identified Album',
		artist_id: 'artist-1',
		artist_name: 'Test Artist',
		album_artist_id: 'artist-1',
		album_artist_name: 'Test Artist',
		musicbrainz_recording_id: null,
		musicbrainz_release_group_id: PROVIDER_RG_MBID,
		musicbrainz_artist_id: null,
		musicbrainz_album_artist_id: null,
		disc_number: 1,
		track_number: 1,
		year: 1997,
		genre: null,
		duration_seconds: 200,
		format: 'flac',
		bit_rate: null,
		sample_rate: null,
		bit_depth: null,
		channels: null,
		file_size_bytes: 1024,
		date_added: 1,
		cover_available: true,
		current_tier: null,
		below_cutoff: false,
		...overrides
	};
}

const identifiedTrack = makeTrack({});
const localOnlyTrack = makeTrack({
	id: 'track-2',
	title: 'Local Only Track',
	album_id: LOCAL_ONLY_ALBUM_ID,
	album_title: 'Local Only Album',
	musicbrainz_release_group_id: null,
	cover_available: false
});

beforeEach(() => {
	vi.clearAllMocks();
	h.isAdmin = false;
	h.post.mockReset();
	vi.spyOn(window, 'confirm').mockReturnValue(true);
	h.get.mockResolvedValue({
		items: [identifiedTrack, localOnlyTrack],
		total: 2,
		offset: 0,
		limit: 48
	});
});

afterEach(() => vi.restoreAllMocks());

async function openCompressionMenu() {
	await page.getByLabelText('More actions').first().click();
	await page.getByRole('menuitem', { name: 'Compress music' }).click();
}

function coverUrls(container: HTMLElement): string {
	return Array.from(container.querySelectorAll('img'))
		.flatMap((img) => [
			img.getAttribute('src') ?? '',
			img.getAttribute('data-src') ?? '',
			img.getAttribute('data-srcset') ?? ''
		])
		.join('|');
}

describe('library track compression', () => {
	it.each([
		['aac', 256],
		['opus', 192]
	] as const)('submits %s and refreshes tracks after success', async (format, bitrate) => {
		h.isAdmin = true;
		h.get.mockResolvedValue({
			items: [makeTrack({ track_file_id: 'file-1' })],
			total: 1,
			offset: 0,
			limit: 48
		});
		h.post.mockResolvedValue({});
		await render(TracksPage);
		await expect.element(page.getByText('Identified Track')).toBeVisible();
		await openCompressionMenu();
		await page
			.getByRole('menuitem', { name: `${format === 'aac' ? 'AAC' : 'Opus'} ${bitrate} kbps` })
			.click();
		expect(h.post).toHaveBeenCalledExactlyOnceWith('/api/v1/library/tracks/file-1/compress', {
			output_format: format,
			bitrate_kbps: bitrate
		});
		await expect
			.poll(() => h.toast.mock.calls.some(([toast]) => toast.type === 'success'))
			.toBe(true);
		expect(
			h.get.mock.calls.filter(([url]) => url.startsWith('/api/v1/library/tracks?')).length
		).toBe(2);
	});

	it('does not submit when confirmation is cancelled', async () => {
		h.isAdmin = true;
		vi.mocked(window.confirm).mockReturnValue(false);
		await render(TracksPage);
		await expect.element(page.getByText('Identified Track')).toBeVisible();
		await openCompressionMenu();
		await page.getByRole('menuitem', { name: 'Opus 192 kbps' }).click();
		expect(h.post).not.toHaveBeenCalled();
	});

	it('blocks duplicate compression while pending and allows retry after an error', async () => {
		h.isAdmin = true;
		let rejectCompression!: (error: Error) => void;
		h.post.mockImplementationOnce(
			() =>
				new Promise((_, reject) => {
					rejectCompression = reject;
				})
		);
		await render(TracksPage);
		await expect.element(page.getByText('Identified Track')).toBeVisible();
		await openCompressionMenu();
		await page.getByRole('menuitem', { name: 'Opus 192 kbps' }).click();
		await page.getByLabelText('More actions').first().click();
		await expect.element(page.getByRole('menuitem', { name: 'Compressing...' })).toBeDisabled();
		expect(h.post).toHaveBeenCalledOnce();
		expect(h.toast).toHaveBeenCalledWith({
			message: 'Compressing "Identified Track"...',
			type: 'info'
		});
		rejectCompression(new Error('Could not compress the audio file.'));
		await expect.element(page.getByRole('menuitem', { name: 'Compress music' })).toBeEnabled();
		expect(h.toast).toHaveBeenCalledWith({
			message: 'Could not compress the audio file.',
			type: 'error'
		});
		h.post.mockResolvedValueOnce({});
		await page.getByRole('menuitem', { name: 'Compress music' }).click();
		await page.getByRole('menuitem', { name: 'AAC 256 kbps' }).click();
		await expect.poll(() => h.post.mock.calls.length).toBe(2);
	});

	it('does not offer compression to non-admin users', async () => {
		await render(TracksPage);
		await expect.element(page.getByText('Identified Track')).toBeVisible();
		await page.getByLabelText('More actions').first().click();
		await expect
			.element(page.getByRole('menuitem', { name: 'Compress music' }))
			.not.toBeInTheDocument();
	});
});

describe('library All Tracks artwork wiring (issue 377)', () => {
	it('requests the provider release-group for identified tracks, never the local album id', async () => {
		const { container } = await render(TracksPage);

		await expect.element(page.getByText('Identified Track')).toBeVisible();
		await expect
			.element(page.getByAltText('Identified Album'))
			.toHaveAttribute('data-src', `/api/v1/covers/release-group/${PROVIDER_RG_MBID}?size=250`);

		const urls = coverUrls(container);
		expect(urls).toContain(PROVIDER_RG_MBID);
		expect(urls).not.toContain(LOCAL_ALBUM_ID);
	});

	it('keeps local-only tracks on the placeholder without requesting the local id', async () => {
		const { container } = await render(TracksPage);

		await expect.element(page.getByText('Local Only Track')).toBeVisible();
		await expect.element(page.getByAltText('Local Only Album')).not.toBeInTheDocument();

		const urls = coverUrls(container);
		expect(urls).not.toContain(LOCAL_ONLY_ALBUM_ID);
		expect(urls).not.toContain(LOCAL_ALBUM_ID);
	});
});
