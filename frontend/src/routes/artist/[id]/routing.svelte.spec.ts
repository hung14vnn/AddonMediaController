import { beforeEach, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';

const h = vi.hoisted(() => ({
	goto: vi.fn(),
	cache: vi.fn().mockResolvedValue(undefined),
	getEnabled: vi.fn()
}));

vi.mock('$app/navigation', () => ({
	goto: (...args: unknown[]) => h.goto(...args)
}));

vi.mock('./LocalArtistPage.svelte', () => {
	const Component = function () {
		h.localView();
	};
	Component.prototype = {};
	return { default: Component };
});

vi.mock('./ProviderArtistPage.svelte', () => {
	const Component = function () {
		h.providerView();
	};
	Component.prototype = {};
	return { default: Component };
});

vi.mock('$lib/queries/library/LibraryQueries.svelte', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/queries/library/LibraryQueries.svelte')>()),
	getLibraryArtistDetailQuery: (_getArtistId: () => string, getEnabled?: () => boolean) => {
		h.getEnabled(getEnabled?.());
		return {
			data: {
				id: 'local-artist-id',
				musicbrainz_artist_id: 'provider-artist-id'
			},
			isLoading: false
		};
	},
	cacheCanonicalLibraryArtistDetail: (...args: unknown[]) => h.cache(...args)
}));

import type { MusicSource } from '$lib/stores/musicSource';
import ArtistPage from './+page.svelte';

beforeEach(() => {
	vi.clearAllMocks();
	h.artist.musicbrainz_artist_id = 'provider-artist-id';
});

it('keeps a linked artist on its MusicBrainz route', async () => {
	render(ArtistPage, {
		props: {
			data: {
				artistId: 'provider-artist-id',
				primarySource: 'listenbrainz' as MusicSource
			}
		}
	} as unknown as Parameters<typeof render>[1]);

	await vi.waitFor(() => expect(h.goto).not.toHaveBeenCalled());
	expect(h.cache).not.toHaveBeenCalled();
	expect(h.providerView).toHaveBeenCalled();
	expect(h.localView).not.toHaveBeenCalled();
});

it('replaces a linked local route with its MusicBrainz route', async () => {
	render(ArtistPage, {
		props: {
			data: {
				artistId: 'local-artist-id',
				primarySource: 'listenbrainz' as MusicSource
			}
		}
	} as unknown as Parameters<typeof render>[1]);

	await vi.waitFor(() => {
		expect(h.goto).toHaveBeenCalledWith('/artist/provider-artist-id', {
			replaceState: true
		});
	});
	expect(h.cache).toHaveBeenCalledWith(expect.objectContaining({ id: 'local-artist-id' }));
	expect(h.providerView).not.toHaveBeenCalled();
	expect(h.localView).not.toHaveBeenCalled();
});

it('keeps a local-only artist on its local route', async () => {
	h.artist.musicbrainz_artist_id = null;
	render(ArtistPage, {
		props: {
			data: {
				artistId: 'local-artist-id',
				primarySource: 'listenbrainz' as MusicSource
			}
		}
	} as unknown as Parameters<typeof render>[1]);

	await vi.waitFor(() => expect(h.goto).not.toHaveBeenCalled());
	expect(h.localView).toHaveBeenCalled();
	expect(h.providerView).not.toHaveBeenCalled();
});

it('keeps a provider-search route on the provider artist page', async () => {
	render(ArtistPage, {
		props: {
			data: {
				artistId: 'provider-artist-id',
				preferProvider: true,
				primarySource: 'listenbrainz' as MusicSource
			}
		}
	} as unknown as Parameters<typeof render>[1]);

	await vi.waitFor(() => expect(h.getEnabled).toHaveBeenCalledWith(false));
	expect(h.goto).not.toHaveBeenCalled();
});
