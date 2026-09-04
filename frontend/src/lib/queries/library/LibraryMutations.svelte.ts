import { createMutation } from '@tanstack/svelte-query';
import { API } from '$lib/constants';
import { api } from '$lib/api/client';
import { libraryStore } from '$lib/stores/library';
import { ArtistQueryKeyFactory } from '../artist/ArtistQueryKeyFactory';
import { DiscoverQueryKeyFactory } from '../discover/DiscoverQueryKeyFactory';
import { HomeQueryKeyFactory } from '../HomeQueryKeyFactory';
import { WantedQueryKeyFactory } from '../wanted/WantedQueryKeyFactory';
import { invalidateQueriesWithPersister, setQueryDataWithPersister } from '../QueryClient';
import { LOCAL_KEYS } from '../local/LocalQueries.svelte';
import { LibraryQueryKeyFactory } from './LibraryQueryKeyFactory';
import type {
	AlbumRemoveResponse,
	TargetCatalogRemovalResponse,
	LibraryAlbumStatus,
	StatusMessageResponse,
	LibraryScanSchedule
} from '$lib/types';
import type { ScanRunRequestedResponse } from './LibraryOperationsTypes';
import { authStore } from '$lib/stores/authStore.svelte';
import { deleteOfflineTracks } from '$lib/offline/offlineAudio';
import { deletePlaybackTracks } from '$lib/player/playbackAudioCache';

async function removeDeviceAudioCopies(trackIds: Iterable<string>): Promise<void> {
	const userId = authStore.user?.id;
	if (!userId) return;
	const uniqueTrackIds = [...new Set(trackIds)];
	await Promise.allSettled([
		deleteOfflineTracks(userId, uniqueTrackIds),
		deletePlaybackTracks(userId, uniqueTrackIds)
	]);
}

export function removeLibraryAlbum() {
	return createMutation(() => ({
		mutationFn: ({ mbid, stopWanted }: { mbid: string; stopWanted: boolean }) =>
			api.global.delete<AlbumRemoveResponse | TargetCatalogRemovalResponse>(
				`${API.library.removeAlbum(mbid)}?delete_files=true&stop_wanted=${stopWanted}`
			),
		onSuccess: async (result, { mbid: requestedMbid }) => {
			const responseMbids =
				'album_mbid' in result ? [result.album_mbid, ...result.removed_mbids] : [result.id];
			const removedMbids = [requestedMbid, ...responseMbids].filter(
				(mbid, index, all) => all.indexOf(mbid) === index
			);
			for (const mbid of removedMbids) {
				libraryStore.removeMbid(mbid);
			}
			try {
				await setQueryDataWithPersister<LibraryAlbumStatus>(
					LibraryQueryKeyFactory.album(requestedMbid),
					(previous) =>
						previous
							? {
									...previous,
									in_library: false,
									track_count: 0,
									tracks: [],
									covered_tracks: 0,
									matched_file_ids: [],
									orphans: []
								}
							: previous
				);
			} catch (error) {
				console.error('Album removal cache update failed', error);
			}
			const refreshes = await Promise.allSettled([
				invalidateQueriesWithPersister({ queryKey: LibraryQueryKeyFactory.all }),
				invalidateQueriesWithPersister({ queryKey: ArtistQueryKeyFactory.prefix }),
				invalidateQueriesWithPersister({ queryKey: HomeQueryKeyFactory.prefix }),
				invalidateQueriesWithPersister({ queryKey: DiscoverQueryKeyFactory.prefix }),
				invalidateQueriesWithPersister({ queryKey: WantedQueryKeyFactory.prefix }),
				invalidateQueriesWithPersister({ queryKey: LOCAL_KEYS.root })
			]);
			for (const refresh of refreshes) {
				if (refresh.status === 'rejected') {
					console.error('Album removal cache refresh failed', refresh.reason);
				}
			}
		}
	}));
}

// Re-invalidate the album status while the accepted scan run advances. The mutation
// consumes the scan-run response shape introduced by the target-only scan cutover.
const RESCAN_REFRESH_DELAYS_MS = [2500, 6000];

export function rescanAlbum() {
	return createMutation(() => ({
		mutationFn: (mbid: string) =>
			api.global.post<ScanRunRequestedResponse>(API.library.rescanAlbum(mbid), {}),
		onSuccess: (_data, mbid) => {
			const invalidate = () =>
				invalidateQueriesWithPersister({ queryKey: LibraryQueryKeyFactory.album(mbid) });
			void invalidate();
			for (const delay of RESCAN_REFRESH_DELAYS_MS) setTimeout(() => void invalidate(), delay);
		}
	}));
}

export function saveLibraryScanSchedule() {
	return createMutation(() => ({
		mutationFn: (schedule: LibraryScanSchedule) =>
			api.global.put<LibraryScanSchedule>(API.library.scanSchedule(), schedule),
		onSuccess: () =>
			invalidateQueriesWithPersister({ queryKey: LibraryQueryKeyFactory.scanSchedule() })
	}));
}

// Remove ONE library file - the album page's orphan-review action (P5): a held
// file that matches none of the album's expected tracks. Admin/trusted only
// (the route enforces it). Invalidates the album's coverage/status AND the
// local-library lists (cross-domain: sizes and sidebars change with the file).
export function removeLibraryTrack() {
	return createMutation(() => ({
		mutationFn: ({ fileId }: { fileId: string; albumMbid?: string; cacheTrackIds?: string[] }) =>
			api.global.delete<StatusMessageResponse>(API.library.removeTrack(fileId)),
		onSuccess: async (_data, { albumMbid, fileId, cacheTrackIds }) => {
			await removeDeviceAudioCopies([fileId, ...(cacheTrackIds ?? [])]);
			if (albumMbid) {
				await invalidateQueriesWithPersister({
					queryKey: LibraryQueryKeyFactory.album(albumMbid)
				});
			}
			await invalidateQueriesWithPersister({ queryKey: LibraryQueryKeyFactory.stats() });
			await invalidateQueriesWithPersister({ queryKey: LOCAL_KEYS.root });
		}
	}));
}

export function removeLibraryTracks() {
	return createMutation(() => ({
		mutationFn: ({ fileIds }: { fileIds: string[]; cacheTrackIds?: string[] }) =>
			api.global.post<StatusMessageResponse>(API.library.removeTracks(), { file_ids: fileIds }),
		onSuccess: async (_data, { fileIds, cacheTrackIds }) => {
			await removeDeviceAudioCopies([...fileIds, ...(cacheTrackIds ?? [])]);
			await invalidateQueriesWithPersister({ queryKey: LibraryQueryKeyFactory.stats() });
			await invalidateQueriesWithPersister({ queryKey: LOCAL_KEYS.root });
		}
	}));
}
