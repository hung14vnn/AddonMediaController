import { api } from '$lib/api/client';
import { API } from '$lib/constants';
import { authStore } from '$lib/stores/authStore.svelte';
import { createMutation } from '@tanstack/svelte-query';
import { invalidateQueriesWithPersister } from '../QueryClient';
import { PlaylistQueryKeyFactory } from '../playlists/PlaylistQueryKeyFactory';

interface ImportSpotifyPlaylistInput {
	url: string;
}

export const createImportSpotifyPlaylistMutation = () =>
	createMutation(() => ({
		mutationFn: (input: ImportSpotifyPlaylistInput) =>
			api.global.post<{ playlist_id: string }>(API.me.spotifyImport(), { url: input.url }),
		onSuccess: () => {
			invalidateQueriesWithPersister({
				queryKey: PlaylistQueryKeyFactory.list(authStore.user?.id)
			});
		}
	}));
