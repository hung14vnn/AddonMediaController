import type { PageLoad } from './$types';

export const load: PageLoad = async ({ params, url }) => {
	return {
		artistId: params.id,
		preferProvider: url.searchParams.get('source') === 'provider'
	};
};
