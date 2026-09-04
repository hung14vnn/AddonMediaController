import { createMutation, createQuery } from '@tanstack/svelte-query';
import { api } from '$lib/api/client';
import { API } from '$lib/constants';
import { invalidateQueriesWithPersister } from '$lib/queries/QueryClient';
import { LibraryQueryKeyFactory } from './LibraryQueryKeyFactory';
import { toastStore } from '$lib/stores/toast';
import type { KaraokeCacheEntriesResponse } from '$lib/types';

export const getKaraokeEntriesQuery = () =>
	createQuery(() => ({
		staleTime: 0,
		queryKey: LibraryQueryKeyFactory.karaokeEntries(),
		queryFn: ({ signal }) =>
			api.global.get<KaraokeCacheEntriesResponse>(API.karaoke.entries(), { signal })
	}));

export const deleteKaraokeEntry = () =>
	createMutation(() => ({
		mutationFn: (id: string) => api.global.delete(API.karaoke.deleteEntry(), { body: { id } }),
		onSuccess: () => {
			void invalidateQueriesWithPersister({ queryKey: LibraryQueryKeyFactory.karaokeEntries() });
			toastStore.show({ message: 'Karaoke cache entry removed', type: 'success' });
		},
		onError: (error: unknown) =>
			toastStore.show({
				message: error instanceof Error ? error.message : 'Could not remove karaoke cache entry',
				type: 'error'
			})
	}));
