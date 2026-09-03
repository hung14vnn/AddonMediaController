<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { withBasePath } from '$lib/utils/basePath';
	import { API } from '$lib/constants';
	import { api } from '$lib/api/client';
	import {
		addTracksToPlaylist,
		checkTrackMembership,
		queueItemToTrackData,
		trackDataToMembershipIdentifier
	} from '$lib/api/playlists';
	import { buildDiscoveryQueueFromLocal } from '$lib/player/queueHelpers';
	import { playerStore } from '$lib/stores/player.svelte';
	import { toastStore } from '$lib/stores/toast';
	import { authStore } from '$lib/stores/authStore.svelte';
	import { invalidateQueriesWithPersister } from '$lib/queries/QueryClient';
	import { PlaylistQueryKeyFactory } from '$lib/queries/playlists/PlaylistQueryKeyFactory';
	import { createLibraryTrackLoader } from '$lib/utils/libraryTrackLoader.svelte';
	import NowPlayingIndicator from '$lib/components/NowPlayingIndicator.svelte';
	import AlbumImage from '$lib/components/AlbumImage.svelte';
	import TrackAccessModal from '$lib/components/TrackAccessModal.svelte';
	import ContextMenu from '$lib/components/ContextMenu.svelte';
	import { openGlobalPlaylistModal } from '$lib/stores/playlistModal.svelte';
	import type { MenuItem } from '$lib/components/ContextMenu.svelte';
	import { formatArtistCredit, formatDurationSec } from '$lib/utils/formatting';
	import { reveal } from '$lib/actions/reveal';
	import {
		ChevronLeft,
		ChevronRight,
		Check,
		Download,
		Play,
		Shuffle,
		ListPlus,
		ListStart,
		Loader2,
		Music2,
		Search,
		Trash2,
		Users,
		X
	} from 'lucide-svelte';
	import type { NativeTrackListItem, NativeTrackPage, TrackSort } from '$lib/types';
	import {
		removeLibraryTrack,
		removeLibraryTracks
	} from '$lib/queries/library/LibraryMutations.svelte';
	import { untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import {
		deleteOfflineTrack,
		downloadOfflineTrack,
		listOfflineTrackMetadata,
		type OfflineTrackMetadata
	} from '$lib/offline/offlineAudio';

	const PAGE_SIZE = 48;

	let loading = $state(true);
	let data = $state<NativeTrackPage>({ items: [], total: 0, offset: 0, limit: PAGE_SIZE });
	let currentPage = $state(0);
	let searchQuery = $state('');
	let sort = $state<TrackSort>('recent');
	let searchTimeout: ReturnType<typeof setTimeout> | undefined;
	let selectionEnabled = $state(false);
	let selectedIds = new SvelteSet<string>();
	let bulkDeleting = $state(false);
	let addingToPlaylist = $state(false);
	let offlineOnly = $state(false);
	let accessTrack = $state<NativeTrackListItem | null>(null);
	let targetSelectionInitialized = false;
	let targetMembershipGeneration = 0;
	let existingTargetTrackIds = new SvelteSet<string>();
	let offlineAvailableIds = new SvelteSet<string>();
	let offlineDownloadingIds = new SvelteSet<string>();
	let bulkOfflineDownloading = $state(false);

	const totalPages = $derived(Math.ceil(data.total / PAGE_SIZE));
	let targetPlaylistId = $derived(page.url.searchParams.get('playlist'));
	let selectableTrackCount = $derived(
		data.items.filter((track) => !existingTargetTrackIds.has(track.id)).length
	);
	let selectedOfflineCount = $derived(
		data.items.filter((track) => selectedIds.has(track.id) && isOfflineAvailable(track)).length
	);
	const remove = removeLibraryTrack();
	const removeMultiple = removeLibraryTracks();

	$effect(() => {
		if (targetPlaylistId && !targetSelectionInitialized) {
			selectionEnabled = true;
			targetSelectionInitialized = true;
		}
	});

	const loader = createLibraryTrackLoader<NativeTrackListItem>(
		{
			fetchPageUrl: (limit, offset) => API.library.tracks(limit, offset, sort, searchQuery),
			buildQueue: (tracks) => buildDiscoveryQueueFromLocal(tracks),
			pageSize: PAGE_SIZE
		},
		(items) => playerStore.appendQueueSilent(items),
		(items, startIndex, shuffle) => playerStore.playQueue(items, startIndex, shuffle),
		() => playerStore.regenerateShuffleOrder(),
		(message, type) => toastStore.show({ message, type })
	);

	async function fetchTracks() {
		loader.abort();
		loading = true;
		try {
			if (typeof navigator !== 'undefined' && navigator.onLine === false) {
				throw new Error('offline');
			}
			data = await api.global.get<NativeTrackPage>(
				API.library.tracks(PAGE_SIZE, currentPage * PAGE_SIZE, sort, searchQuery),
				{ timeoutMs: 5_000 }
			);
			offlineOnly = false;
			await refreshTargetMembership(data.items);
			await refreshOfflineStatuses(data.items);
		} catch {
			existingTargetTrackIds.clear();
			try {
				data = await loadOfflineFallback();
				offlineOnly = true;
				await refreshOfflineStatuses(data.items);
			} catch {
				data = { items: [], total: 0, offset: 0, limit: PAGE_SIZE };
				offlineOnly = false;
				offlineAvailableIds = new SvelteSet();
			}
		} finally {
			loading = false;
		}
	}

	function offlineRecordToTrack(record: OfflineTrackMetadata): NativeTrackListItem {
		return {
			id: record.libraryTrackId ?? record.trackId,
			track_file_id: record.trackId,
			title: record.title,
			album_id: record.albumId ?? '',
			album_title: record.albumName,
			artist_id: record.artistId ?? '',
			artist_name: record.artistName,
			album_artist_id: record.artistId ?? '',
			album_artist_name: record.artistName,
			musicbrainz_recording_id: null,
			musicbrainz_release_group_id: null,
			musicbrainz_artist_id: null,
			musicbrainz_album_artist_id: null,
			disc_number: record.discNumber ?? 1,
			track_number: record.trackNumber ?? 0,
			year: null,
			genre: null,
			duration_seconds: record.durationSeconds ?? 0,
			format: record.format,
			bit_rate: null,
			sample_rate: null,
			bit_depth: null,
			channels: null,
			file_size_bytes: record.sizeBytes,
			date_added: record.storedAt,
			cover_available: Boolean(record.coverUrl),
			cover_url: record.coverUrl,
			current_tier: null,
			below_cutoff: false
		};
	}

	async function loadOfflineFallback(): Promise<NativeTrackPage> {
		const userId = authStore.user?.id;
		if (!userId) return { items: [], total: 0, offset: 0, limit: PAGE_SIZE };
		const query = searchQuery.trim().toLocaleLowerCase();
		const records = (await listOfflineTrackMetadata(userId))
			.filter((record) => {
				if (!query) return true;
				return `${record.title} ${record.artistName} ${record.albumName}`
					.toLocaleLowerCase()
					.includes(query);
			})
			.sort((a, b) => {
				if (sort === 'title') return a.title.localeCompare(b.title);
				if (sort === 'artist') return a.artistName.localeCompare(b.artistName);
				if (sort === 'album') return a.albumName.localeCompare(b.albumName);
				return b.storedAt - a.storedAt;
			});
		const items = records.map(offlineRecordToTrack);
		return { items, total: items.length, offset: 0, limit: PAGE_SIZE };
	}

	function localTrackId(track: NativeTrackListItem): string {
		return String(track.track_file_id ?? track.id);
	}

	function isOfflineAvailable(track: NativeTrackListItem): boolean {
		return offlineAvailableIds.has(localTrackId(track));
	}

	function isOfflineDownloading(track: NativeTrackListItem): boolean {
		return offlineDownloadingIds.has(localTrackId(track));
	}

	async function refreshOfflineStatuses(tracks: NativeTrackListItem[]): Promise<void> {
		const userId = authStore.user?.id;
		if (!userId) {
			offlineAvailableIds = new SvelteSet();
			return;
		}
		try {
			const records: OfflineTrackMetadata[] = await listOfflineTrackMetadata(userId);
			const pageIds = new SvelteSet(
				records
					.filter((record) => tracks.some((track) => localTrackId(track) === record.trackId))
					.map((record) => record.trackId)
			);
			const next = new SvelteSet(offlineAvailableIds);
			for (const track of tracks) {
				const id = localTrackId(track);
				if (pageIds.has(id)) next.add(id);
				else next.delete(id);
			}
			offlineAvailableIds = next;
		} catch {
			// A storage failure must not make the online library unusable.
		}
	}

	function offlineDownloadInput(track: NativeTrackListItem) {
		const trackId = localTrackId(track);
		return {
			userId: authStore.user?.id ?? '',
			trackId,
			libraryTrackId: track.id,
			sourceUrl: API.stream.local(trackId),
			title: track.title,
			artistName: track.artist_name,
			albumName: track.album_name ?? track.album_title,
			albumId: track.album_mbid ?? track.album_id,
			artistId: track.artist_mbid ?? track.artist_id,
			coverUrl: track.cover_url ?? null,
			trackNumber: track.track_number,
			discNumber: track.disc_number,
			format: (track.format ?? '').toLowerCase(),
			durationSeconds: track.duration_seconds
		};
	}

	async function toggleOffline(track: NativeTrackListItem): Promise<void> {
		const userId = authStore.user?.id;
		const trackId = localTrackId(track);
		if (!userId || offlineDownloadingIds.has(trackId)) return;

		if (isOfflineAvailable(track)) {
			if (!confirm(`Remove the offline copy of "${track.title}"?`)) return;
			try {
				await deleteOfflineTrack(userId, trackId);
				offlineAvailableIds.delete(trackId);
				toastStore.show({ message: `Removed offline copy of "${track.title}"`, type: 'info' });
			} catch {
				toastStore.show({ message: "Couldn't remove the offline copy", type: 'error' });
			}
			return;
		}

		offlineDownloadingIds.add(trackId);
		try {
			await downloadOfflineTrack(offlineDownloadInput(track));
			offlineAvailableIds.add(trackId);
			toastStore.show({ message: `Saved "${track.title}" for offline playback`, type: 'success' });
		} catch (error) {
			if (!(error instanceof DOMException && error.name === 'AbortError')) {
				toastStore.show({
					message: error instanceof Error ? error.message : "Couldn't save this track offline",
					type: 'error'
				});
			}
		} finally {
			offlineDownloadingIds.delete(trackId);
		}
	}

	async function downloadSelectedOffline(): Promise<void> {
		if (bulkOfflineDownloading || !authStore.user?.id) return;
		const tracks = data.items.filter((track) => selectedIds.has(track.id));
		const pending = tracks.filter((track) => !isOfflineAvailable(track));
		if (pending.length === 0) return;

		bulkOfflineDownloading = true;
		let saved = 0;
		let failed = 0;
		try {
			for (const track of pending) {
				const trackId = localTrackId(track);
				if (offlineDownloadingIds.has(trackId)) continue;
				offlineDownloadingIds.add(trackId);
				try {
					await downloadOfflineTrack(offlineDownloadInput(track));
					offlineAvailableIds.add(trackId);
					saved += 1;
				} catch {
					failed += 1;
				} finally {
					offlineDownloadingIds.delete(trackId);
				}
			}
			toastStore.show({
				message:
					failed > 0
						? `Saved ${saved} track${saved === 1 ? '' : 's'} offline; ${failed} failed`
						: `Saved ${saved} track${saved === 1 ? '' : 's'} for offline playback`,
				type: failed > 0 ? 'error' : 'success'
			});
		} finally {
			bulkOfflineDownloading = false;
		}
	}

	async function refreshTargetMembership(tracks: NativeTrackListItem[]) {
		const generation = ++targetMembershipGeneration;
		existingTargetTrackIds.clear();
		if (!targetPlaylistId || tracks.length === 0) return;
		try {
			const membership = await checkTrackMembership(
				buildDiscoveryQueueFromLocal(tracks).map((track) =>
					trackDataToMembershipIdentifier(queueItemToTrackData(track))
				)
			);
			if (generation !== targetMembershipGeneration) return;
			for (const index of membership[targetPlaylistId] ?? []) {
				const track = tracks[index];
				if (track) existingTargetTrackIds.add(track.id);
			}
		} catch {
			if (generation === targetMembershipGeneration) existingTargetTrackIds.clear();
		}
	}

	function goToPage(page: number) {
		clearSelection();
		currentPage = page;
		fetchTracks();
		window.scrollTo({ top: 0, behavior: 'smooth' });
	}

	function handleSearchInput() {
		clearSelection();
		clearTimeout(searchTimeout);
		searchTimeout = setTimeout(() => {
			currentPage = 0;
			fetchTracks();
		}, 300);
	}

	function clearSearch() {
		clearSelection();
		searchQuery = '';
		clearTimeout(searchTimeout);
		currentPage = 0;
		fetchTracks();
	}

	function handleSortChange(e: Event) {
		clearSelection();
		sort = (e.target as HTMLSelectElement).value as TrackSort;
		currentPage = 0;
		fetchTracks();
	}

	function playTrack(index: number) {
		loader.abort();
		const queue = buildDiscoveryQueueFromLocal(data.items);
		if (queue.length === 0) return;
		playerStore.playQueue(queue, index, false);
	}

	function playAll() {
		if (offlineOnly) {
			const queue = buildDiscoveryQueueFromLocal(data.items);
			if (queue.length > 0) playerStore.playQueue(queue, 0, false);
			return;
		}
		loader.playAll(data.items, data.total);
	}

	function shuffleAll() {
		if (offlineOnly) {
			const queue = buildDiscoveryQueueFromLocal(data.items);
			if (queue.length > 0) playerStore.playQueue(queue, 0, true);
			return;
		}
		loader.shuffleAll(data.items, data.total);
	}

	function addTrackToQueue(track: NativeTrackListItem) {
		const items = buildDiscoveryQueueFromLocal([track]);
		if (items.length === 0) return;
		playerStore.addMultipleToQueue(items);
		toastStore.show({ message: `"${track.title}" was added to the queue`, type: 'info' });
	}

	function playTrackNext(track: NativeTrackListItem) {
		const items = buildDiscoveryQueueFromLocal([track]);
		if (items.length === 0) return;
		playerStore.playMultipleNext(items);
		toastStore.show({ message: `"${track.title}" will play next`, type: 'info' });
	}

	async function addTracksToLocalPlaylist(tracks: NativeTrackListItem[]) {
		const items = buildDiscoveryQueueFromLocal(tracks);
		if (items.length === 0) return;
		if (!targetPlaylistId) {
			openGlobalPlaylistModal(items);
			return;
		}
		if (addingToPlaylist) return;
		addingToPlaylist = true;
		try {
			const membership = await checkTrackMembership(
				items.map((item) => trackDataToMembershipIdentifier(queueItemToTrackData(item)))
			);
			const existingIndices = new Set(membership[targetPlaylistId] ?? []);
			const newItems = items.filter((_, index) => !existingIndices.has(index));
			if (newItems.length > 0) {
				await addTracksToPlaylist(targetPlaylistId, newItems.map(queueItemToTrackData));
			}
			await invalidateQueriesWithPersister({
				queryKey: PlaylistQueryKeyFactory.detail(authStore.user?.id, targetPlaylistId)
			});
			toastStore.show({
				message:
					newItems.length > 0
						? `Added ${newItems.length} track${newItems.length === 1 ? '' : 's'} to the playlist`
						: 'Those tracks are already in the playlist',
				type: newItems.length > 0 ? 'success' : 'info'
			});
			await goto(`/playlists/${targetPlaylistId}`);
		} catch {
			toastStore.show({ message: "Couldn't add those tracks to the playlist", type: 'error' });
		} finally {
			addingToPlaylist = false;
		}
	}

	function deleteTrack(track: NativeTrackListItem) {
		if (
			!confirm(
				`Remove "${track.title}" from your library? The audio file is deleted only if no other user has it.`
			)
		)
			return;
		remove.mutate(
			{ fileId: track.id },
			{
				onSuccess: () => {
					toastStore.show({ message: `Deleted "${track.title}"`, type: 'success' });
					void fetchTracks();
				},
				onError: () => toastStore.show({ message: "Couldn't delete this file", type: 'error' })
			}
		);
	}

	function toggleSelectionEnabled() {
		selectionEnabled = !selectionEnabled;
		if (!selectionEnabled) clearSelection();
	}

	function clearSelection() {
		selectedIds.clear();
	}

	function toggleTrackSelection(trackId: string) {
		if (targetPlaylistId && existingTargetTrackIds.has(trackId)) return;
		if (selectedIds.has(trackId)) selectedIds.delete(trackId);
		else selectedIds.add(trackId);
	}

	function toggleSelectAll() {
		const selectableTracks = data.items.filter((track) => !existingTargetTrackIds.has(track.id));
		if (selectableTracks.length > 0 && selectedIds.size === selectableTracks.length)
			clearSelection();
		else selectableTracks.forEach((track) => selectedIds.add(track.id));
	}

	async function deleteSelectedTracks() {
		if (bulkDeleting || selectedIds.size === 0) return;
		const tracks = data.items.filter((track) => selectedIds.has(track.id));
		const count = tracks.length;
		if (
			!confirm(
				`Remove ${count} track${count === 1 ? '' : 's'} from your library? Audio files are deleted only when no other user has them.`
			)
		)
			return;
		bulkDeleting = true;
		try {
			await removeMultiple.mutateAsync({ fileIds: tracks.map((track) => track.id) });
			toastStore.show({
				message: `Deleted ${count} track${count === 1 ? '' : 's'}`,
				type: 'success'
			});
			clearSelection();
			await fetchTracks();
		} catch {
			toastStore.show({ message: "Couldn't delete the selected tracks", type: 'error' });
			clearSelection();
			await fetchTracks();
		} finally {
			bulkDeleting = false;
		}
	}

	function getTrackMenuItems(track: NativeTrackListItem): MenuItem[] {
		return [
			{
				label: isOfflineAvailable(track)
					? 'Remove offline copy'
					: isOfflineDownloading(track)
						? 'Saving offline copy...'
						: 'Save for offline playback',
				icon: isOfflineAvailable(track) ? Check : Download,
				onclick: () => void toggleOffline(track),
				disabled: isOfflineDownloading(track)
			},
			{
				label: 'Add to local playlist',
				icon: Music2,
				onclick: () => void addTracksToLocalPlaylist([track]),
				disabled: !!targetPlaylistId && existingTargetTrackIds.has(track.id)
			},
			{ label: 'Add to Queue', icon: ListPlus, onclick: () => addTrackToQueue(track) },
			{ label: 'Play Next', icon: ListStart, onclick: () => playTrackNext(track) },
			...(authStore.isAdmin
				? [{ label: 'Track access', icon: Users, onclick: () => (accessTrack = track) }]
				: []),
			{
				label: 'Delete from library',
				icon: Trash2,
				onclick: () => deleteTrack(track),
				disabled: offlineOnly || remove.isPending,
				className: 'text-error'
			}
		];
	}

	function isTrackPlaying(track: NativeTrackListItem): boolean {
		return (
			playerStore.isPlaying &&
			playerStore.currentQueueItem?.trackSourceId === localTrackId(track) &&
			playerStore.currentQueueItem?.sourceType === 'local'
		);
	}

	// untrack stops this mount-fetch re-running on state changes (handlers refetch), avoiding double-fetch
	$effect(() => {
		untrack(() => fetchTracks());
		return () => loader.abort();
	});
</script>

<svelte:head><title>Tracks · Library</title></svelte:head>

<div class="container mx-auto p-4 md:p-6 lg:p-8">
	<div class="flex items-center gap-4 mb-6">
		<button
			class="btn btn-ghost btn-circle"
			onclick={() => goto(withBasePath('/library'))}
			aria-label="Back to library"
		>
			<ChevronLeft class="w-6 h-6" />
		</button>
		<div>
			<h1 class="text-3xl font-bold">All Tracks</h1>
			<p class="text-base-content/70 text-sm mt-1">
				{data.total.toLocaleString()}
				{data.total === 1 ? 'track' : 'tracks'}
			</p>
			{#if offlineOnly}
				<p class="mt-1 text-xs text-accent">Offline mode · saved tracks on this device</p>
			{/if}
		</div>
	</div>

	<div class="flex flex-col sm:flex-row gap-3 mb-6">
		<div class="relative group flex-1">
			<Search
				class="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-base-content/40
				group-focus-within:text-primary transition-colors duration-200 pointer-events-none"
			/>
			<input
				type="text"
				placeholder="Search tracks..."
				class="input input-bordered w-full rounded-full pl-11 pr-12"
				bind:value={searchQuery}
				oninput={handleSearchInput}
				aria-label="Search tracks"
			/>
			{#if searchQuery}
				<button
					type="button"
					class="absolute right-3 top-1/2 -translate-y-1/2 btn btn-sm btn-ghost btn-circle"
					onclick={clearSearch}
					aria-label="Clear search"
				>
					<X class="h-4 w-4" />
				</button>
			{/if}
		</div>
		<select
			class="select select-bordered rounded-full"
			value={sort}
			onchange={handleSortChange}
			aria-label="Sort tracks"
		>
			<option value="recent">Recently added</option>
			<option value="title">Title</option>
			<option value="artist">Artist</option>
			<option value="album">Album</option>
		</select>
	</div>

	{#if loading}
		<div class="overflow-hidden rounded-xl bg-base-100/40 shadow-sm">
			{#each Array(12) as _, i (i)}
				<div class="flex items-center gap-3 px-3 py-2">
					<div class="skeleton h-12 w-12 shrink-0 rounded-md"></div>
					<div class="flex-1 space-y-2">
						<div class="skeleton h-3.5 w-48"></div>
						<div class="skeleton h-3 w-32"></div>
					</div>
					<div class="skeleton h-3 w-10 shrink-0"></div>
				</div>
			{/each}
		</div>
	{:else if data.items.length === 0}
		<div class="flex flex-col items-center justify-center py-20 text-base-content/50">
			<Music2 class="mb-4 h-12 w-12 opacity-20" />
			<p class="text-lg font-medium">
				{offlineOnly
					? searchQuery
						? 'No saved matches'
						: 'No offline tracks saved'
					: searchQuery
						? 'No matches'
						: 'No tracks yet'}
			</p>
			<p class="mt-1 text-sm">
				{offlineOnly
					? 'Connect to the server and save tracks from your Library for offline playback.'
					: searchQuery
						? 'Try another search term.'
						: 'Scan your library to see tracks here.'}
			</p>
		</div>
	{:else}
		<div class="mb-4 flex flex-wrap items-center gap-2">
			{#if loader.loading}
				<button
					class="btn btn-sm btn-primary gap-1.5"
					onclick={() => loader.abort()}
					aria-busy="true"
					aria-label="Stop loading tracks"
				>
					<Loader2 class="h-3.5 w-3.5 animate-spin" />
					{loader.progressText ?? 'Loading tracks'}
				</button>
			{:else}
				<button
					class="btn btn-sm btn-primary gap-1.5"
					onclick={playAll}
					aria-label="Play all tracks"
				>
					<Play class="h-3.5 w-3.5 fill-current" />
					Play All
				</button>
				<button
					class="btn btn-sm btn-ghost gap-1.5"
					onclick={shuffleAll}
					aria-label="Shuffle all tracks"
				>
					<Shuffle class="h-3.5 w-3.5" />
					Shuffle
				</button>
				{#if targetPlaylistId}
					<span class="badge badge-outline badge-sm">Choose tracks to add</span>
				{:else}
					<button
						class="btn btn-sm gap-1.5 {selectionEnabled ? 'btn-secondary' : 'btn-ghost'}"
						onclick={toggleSelectionEnabled}
						aria-pressed={selectionEnabled}
					>
						{selectionEnabled ? 'Done selecting' : 'Select tracks'}
					</button>
				{/if}
			{/if}
			{#if selectionEnabled}
				<label class="ml-auto flex cursor-pointer items-center gap-2 text-sm text-base-content/70">
					<input
						type="checkbox"
						class="checkbox checkbox-sm"
						checked={selectableTrackCount > 0 && selectedIds.size === selectableTrackCount}
						indeterminate={selectedIds.size > 0 && selectedIds.size < selectableTrackCount}
						onchange={toggleSelectAll}
						disabled={selectableTrackCount === 0}
					/>
					Select available
				</label>
			{/if}
		</div>

		<div
			class="divide-y divide-base-content/5 overflow-hidden rounded-xl bg-base-100/40 shadow-sm"
			use:reveal
		>
			{#each data.items as track, i (track.id)}
				{@const playing = isTrackPlaying(track)}
				{@const alreadyInTarget = !!targetPlaylistId && existingTargetTrackIds.has(track.id)}
				{@const offline = isOfflineAvailable(track)}
				{@const offlineSaving = isOfflineDownloading(track)}
				<div
					class="group flex items-center gap-3 px-3 py-2 transition-colors {alreadyInTarget
						? 'cursor-not-allowed bg-base-200/50 opacity-45'
						: selectedIds.has(track.id)
							? 'cursor-pointer bg-primary/10'
							: playing
								? 'cursor-pointer bg-accent/10'
								: 'cursor-pointer hover:bg-base-200/50'}"
					onclick={() =>
						!alreadyInTarget && (selectionEnabled ? toggleTrackSelection(track.id) : playTrack(i))}
					onkeydown={(e) =>
						(e.key === 'Enter' || e.key === ' ') &&
						!alreadyInTarget &&
						(e.preventDefault(), selectionEnabled ? toggleTrackSelection(track.id) : playTrack(i))}
					tabindex={alreadyInTarget ? -1 : 0}
					role="button"
					aria-disabled={alreadyInTarget}
					aria-label={alreadyInTarget
						? `${track.title} is already in this playlist`
						: selectionEnabled
							? `Select ${track.title}`
							: `Play ${track.title}`}
				>
					{#if selectionEnabled}
						<input
							type="checkbox"
							class="checkbox checkbox-sm shrink-0"
							checked={selectedIds.has(track.id)}
							onclick={(e) => e.stopPropagation()}
							onchange={() => toggleTrackSelection(track.id)}
							aria-label="Select {track.title}"
							disabled={alreadyInTarget}
						/>
					{/if}
					<div class="relative h-12 w-12 shrink-0">
						<AlbumImage
							mbid={track.album_id}
							source="local"
							available={track.cover_available}
							customUrl={track.cover_url}
							alt={track.album_title}
							size="full"
							requestSize={250}
							rounded="md"
							className="h-12 w-12 ring-1 ring-base-content/10"
						/>
						<div
							class="absolute inset-0 flex items-center justify-center rounded-md bg-black/45 transition-opacity {alreadyInTarget ||
							playing
								? 'opacity-100'
								: 'opacity-0 group-hover:opacity-100'}"
						>
							{#if alreadyInTarget}
								<Check class="h-5 w-5 text-success" />
							{:else if playing}
								<NowPlayingIndicator />
							{:else}
								<Play class="h-5 w-5 fill-current text-white" />
							{/if}
						</div>
					</div>

					<div class="min-w-0 flex-1">
						<div class="truncate text-sm font-semibold {playing ? 'text-accent' : ''}">
							{track.title}
						</div>
						<div class="truncate text-xs text-base-content/55">
							{formatArtistCredit(track.artist_name)}{#if track.album_title}<span
									class="text-base-content/35"
								>
									· {track.album_title}</span
								>{/if}
						</div>
					</div>

					<div class="flex shrink-0 items-center gap-2">
						{#if alreadyInTarget}
							<span class="badge badge-ghost badge-xs">In playlist</span>
						{/if}
						{#if track.format}
							<span
								class="hidden text-[10px] font-medium uppercase tracking-wide text-base-content/30 sm:inline"
							>
								{track.format}
							</span>
						{/if}
						{#if track.duration_seconds != null}
							<span
								class="text-xs tabular-nums text-base-content/40 {playing ? 'text-accent/60' : ''}"
							>
								{formatDurationSec(track.duration_seconds)}
							</span>
						{/if}
						<button
							type="button"
							class="btn btn-ghost btn-xs btn-circle"
							onclick={(e) => (e.stopPropagation(), void toggleOffline(track))}
							disabled={offlineSaving}
							title={offline ? 'Remove offline copy' : 'Save for offline playback'}
							aria-label={offline
								? `Remove offline copy of ${track.title}`
								: `Save ${track.title} offline`}
						>
							{#if offlineSaving}
								<Loader2 class="h-3.5 w-3.5 animate-spin" />
							{:else if offline}
								<Check class="h-3.5 w-3.5 text-success" />
							{:else}
								<Download class="h-3.5 w-3.5" />
							{/if}
						</button>
						{#if !alreadyInTarget}
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div
								class="opacity-0 transition-opacity group-hover:opacity-100"
								onclick={(e) => e.stopPropagation()}
								onkeydown={(e) => e.stopPropagation()}
							>
								<ContextMenu items={getTrackMenuItems(track)} position="end" size="xs" />
							</div>
						{/if}
					</div>
				</div>
			{/each}
		</div>

		{#if selectionEnabled && selectedIds.size > 0}
			<div
				class="droppedneedle-selection-toolbar fixed bottom-4 left-1/2 z-[70] flex -translate-x-1/2 items-center gap-3 rounded-box border border-base-content/10 bg-base-300 px-4 py-3 shadow-xl"
				class:droppedneedle-selection-toolbar--player={playerStore.isPlayerVisible}
			>
				<span class="text-sm font-medium">{selectedIds.size} selected</span>
				<button class="btn btn-ghost btn-sm" onclick={clearSelection}>Clear</button>
				<button
					class="btn btn-primary btn-sm gap-1.5"
					onclick={() =>
						void addTracksToLocalPlaylist(data.items.filter((track) => selectedIds.has(track.id)))}
					disabled={addingToPlaylist}
				>
					{#if addingToPlaylist}<span class="loading loading-spinner loading-xs"
						></span>{:else}<Music2 class="h-4 w-4" />{/if}
					Add to playlist
				</button>
				<button
					class="btn btn-secondary btn-sm gap-1.5"
					onclick={() => void downloadSelectedOffline()}
					disabled={bulkOfflineDownloading || selectedOfflineCount === selectedIds.size}
					aria-busy={bulkOfflineDownloading}
				>
					{#if bulkOfflineDownloading}<span class="loading loading-spinner loading-xs"
						></span>{:else}<Download class="h-4 w-4" />{/if}
					Save offline
				</button>
				{#if !targetPlaylistId}
					<button
						class="btn btn-error btn-sm"
						onclick={() => void deleteSelectedTracks()}
						disabled={offlineOnly || bulkDeleting}
					>
						{#if bulkDeleting}<span class="loading loading-spinner loading-xs"></span>{:else}<Trash2
								class="h-4 w-4"
							/>{/if}
						Delete selected
					</button>
				{/if}
			</div>
		{/if}

		{#if totalPages > 1 && !offlineOnly}
			<div class="mt-8 flex items-center justify-center gap-2">
				<button
					class="btn btn-ghost btn-sm"
					disabled={currentPage === 0}
					onclick={() => goToPage(currentPage - 1)}
					aria-label="Previous page"
				>
					<ChevronLeft class="h-4 w-4" />
				</button>
				<span class="text-sm text-base-content/70">
					Page {currentPage + 1} of {totalPages}
				</span>
				<button
					class="btn btn-ghost btn-sm"
					disabled={currentPage >= totalPages - 1}
					onclick={() => goToPage(currentPage + 1)}
					aria-label="Next page"
				>
					<ChevronRight class="h-4 w-4" />
				</button>
			</div>
		{/if}
	{/if}
</div>

<TrackAccessModal track={accessTrack} onclose={() => (accessTrack = null)} />
