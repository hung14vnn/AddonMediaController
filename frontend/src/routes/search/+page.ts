import { getCombinedSearchQueryOptions } from '$lib/queries/search/SearchQueries.svelte';
import { queryClient } from '$lib/queries/QueryClient';
import { authStore } from '$lib/stores/authStore.svelte';
import type { PageLoad } from './$types';

// Warm the same combined payload used by the page. This keeps initial navigation
// to one cacheable request instead of separately fetching local/remote buckets.
export const load: PageLoad = ({ url }) => {
	const q = url.searchParams.get('q') ?? '';
	const query = q.trim();
	if (authStore.user?.id && query.length >= 2) {
		void queryClient.prefetchQuery(getCombinedSearchQueryOptions(query));
	}
	return { query: q };
};
