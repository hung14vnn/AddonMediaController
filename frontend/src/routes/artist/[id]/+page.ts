import { getLibraryArtistDetailQueryOptions } from '$lib/queries/library/LibraryQueries.svelte';
import { queryClient } from '$lib/queries/QueryClient';
import type { PageLoad } from './$types';

export const load: PageLoad = ({ params, url }) => {
	void queryClient.prefetchQuery(getLibraryArtistDetailQueryOptions(params.id));
	return {
		artistId: params.id,
		preferProvider: url.searchParams.get('source') === 'provider'
	};
};
