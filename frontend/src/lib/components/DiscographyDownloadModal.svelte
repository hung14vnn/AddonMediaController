<script lang="ts">
	import { Download, X, Disc3, Check, Loader2, Library } from 'lucide-svelte';
	import { discographyDownloadStore } from '$lib/stores/discographyDownload.svelte';
	import { batchDownloadStore } from '$lib/stores/batchDownloadStatus.svelte';
	import {
		requestBatch,
		type BatchAlbumItem,
		requestSpotifyTracks
	} from '$lib/queries/downloads/DownloadMutations.svelte';
	import { authStore } from '$lib/stores/authStore.svelte';
	import AlbumImage from '$lib/components/AlbumImage.svelte';
	import { api } from '$lib/api/client';
	import { API } from '$lib/constants';
	import type { AlbumTracksInfo } from '$lib/types';
	import { formatDuration } from '$lib/utils/formatting';

	let dialogEl: HTMLDialogElement | undefined = $state();
	let submitting = $state(false);
	let includeAlbums = $state(true);
	let includeEPs = $state(true);
	let includeSingles = $state(true);
	let monitorArtist = $state(false);
	let autoDownload = $state(false);
	let loadingTracks = $state(false);
	let trackLoadError = $state(false);
	let trackLoadKey = $state('');
	let selectedTrackIds = $state<string[]>([]);

	type DiscographyTrack = {
		id: string;
		albumTitle: string;
		title: string;
		trackNumber: number;
		durationMs?: number | null;
	};
	let discographyTracks = $state<DiscographyTrack[]>([]);

	const batchRequest = requestBatch();
	const spotifyTrackBatchRequest = requestSpotifyTracks();
	$effect(() => {
		if (discographyDownloadStore.open) {
			includeAlbums = true;
			includeEPs = true;
			includeSingles = true;
			monitorArtist = false;
			autoDownload = false;
			submitting = false;
			trackLoadKey = '';
			discographyTracks = [];
			selectedTrackIds = [];
		}
	});

	let filteredReleases = $derived.by(() => {
		const types = new Set<string>(); // eslint-disable-line svelte/prefer-svelte-reactivity
		if (includeAlbums) types.add('Album');
		if (includeEPs) types.add('EP');
		if (includeSingles) types.add('Single');
		return discographyDownloadStore.releases.filter(
			(r) => types.has(r.type ?? 'Album') && !r.in_library && !r.requested
		);
	});
	let spotifyDiscography = $derived(
		discographyDownloadStore.releases.some((release) => release.id.startsWith('spotify:album:'))
	);
	let spotifyTrackReleases = $derived(
		filteredReleases.filter((release) => release.id.startsWith('spotify:album:'))
	);

	$effect(() => {
		if (!discographyDownloadStore.open || !spotifyDiscography) return;
		const key = spotifyTrackReleases.map((release) => release.id).join('|');
		if (key === trackLoadKey) return;
		trackLoadKey = key;
		loadingTracks = true;
		trackLoadError = false;
		discographyTracks = [];
		selectedTrackIds = [];
		void Promise.all(
			spotifyTrackReleases.map(async (release) => {
				const data = await api.global.get<AlbumTracksInfo>(API.album.tracks(release.id));
				return data.tracks
					.filter((track) => track.recording_id?.startsWith('spotify:track:'))
					.map((track) => ({
						id: track.recording_id!.slice('spotify:track:'.length),
						albumTitle: release.title,
						title: track.title,
						trackNumber: track.position,
						durationMs: track.length
					}));
			})
		)
			.then((groups) => {
				discographyTracks = groups.flat();
				selectedTrackIds = discographyTracks.map((track) => track.id);
			})
			.catch(() => (trackLoadError = true))
			.finally(() => (loadingTracks = false));
	});

	let inLibraryCount = $derived(
		discographyDownloadStore.releases.filter((r) => r.in_library).length
	);
	let requestedCount = $derived(
		discographyDownloadStore.releases.filter((r) => r.requested && !r.in_library).length
	);
	let totalReleases = $derived(discographyDownloadStore.releases.length);

	let albumCount = $derived(
		discographyDownloadStore.releases.filter((r) => (r.type ?? 'Album') === 'Album').length
	);
	let epCount = $derived(discographyDownloadStore.releases.filter((r) => r.type === 'EP').length);
	let singleCount = $derived(
		discographyDownloadStore.releases.filter((r) => r.type === 'Single').length
	);

	$effect(() => {
		if (discographyDownloadStore.open && dialogEl) {
			dialogEl.showModal();
		} else if (!discographyDownloadStore.open && dialogEl?.open) {
			dialogEl.close();
		}
	});

	function handleClose() {
		dialogEl?.close();
		discographyDownloadStore.close();
	}

	async function handleDownload() {
		if (spotifyDiscography) {
			if (loadingTracks || selectedTrackIds.length === 0) return;
			submitting = true;
			const result = await spotifyTrackBatchRequest.mutateAsync(selectedTrackIds).catch(() => null);
			if (result) handleClose();
			submitting = false;
			return;
		}
		if (filteredReleases.length === 0) return;
		const artistName = discographyDownloadStore.artistName;
		const artistId = discographyDownloadStore.artistId;
		const initiatingUserId = authStore.user?.id;
		submitting = true;

		const items: BatchAlbumItem[] = filteredReleases.map((r) => ({
			musicbrainz_id: r.id,
			artist_name: artistName,
			album_title: r.title,
			year: r.year ?? undefined,
			artist_mbid: artistId
		}));

		const result = await batchRequest
			.mutateAsync({
				items,
				monitorArtist,
				autoDownloadArtist: autoDownload
			})
			.catch(() => null);
		// an in-flight batch that resolves after an account switch belongs to the prior
		// session - the shell already cleared the stores, do not re-add the old job (#155)
		if (result?.success && authStore.user?.id === initiatingUserId) {
			batchDownloadStore.addJob(
				artistName,
				artistId,
				items.map((i) => i.musicbrainz_id)
			);
			handleClose();
		}

		submitting = false;
	}

	function toggleTrack(id: string) {
		selectedTrackIds = selectedTrackIds.includes(id)
			? selectedTrackIds.filter((selected) => selected !== id)
			: [...selectedTrackIds, id];
	}

	function toggleAllTracks() {
		selectedTrackIds =
			selectedTrackIds.length === discographyTracks.length
				? []
				: discographyTracks.map((track) => track.id);
	}
</script>

{#if discographyDownloadStore.open}
	<dialog bind:this={dialogEl} class="modal" onclose={handleClose}>
		<div class="modal-box max-w-lg">
			<div class="flex items-center justify-between mb-4">
				<div class="flex items-center gap-3">
					<div class="bg-accent/10 rounded-full p-2">
						<Download class="h-5 w-5 text-accent" />
					</div>
					<div>
						<h3 class="text-lg font-bold">Download Discography</h3>
						<p class="text-sm text-base-content/60">{discographyDownloadStore.artistName}</p>
					</div>
				</div>
				<button class="btn btn-ghost btn-sm btn-circle" onclick={handleClose} aria-label="Close">
					<X class="h-4 w-4" />
				</button>
			</div>

			<div class="flex gap-2 flex-wrap mb-4">
				<div class="badge badge-ghost gap-1">
					<Disc3 class="h-3 w-3" />
					{totalReleases} total
				</div>
				{#if inLibraryCount > 0}
					<div class="badge badge-success gap-1">
						<Check class="h-3 w-3" />
						{inLibraryCount} in library
					</div>
				{/if}
				{#if requestedCount > 0}
					<div class="badge badge-info gap-1">
						<Loader2 class="h-3 w-3" />
						{requestedCount} requested
					</div>
				{/if}
			</div>

			{#if !spotifyDiscography}
				<div class="bg-base-200/50 rounded-box p-3 mb-4">
					<p class="text-xs font-medium text-base-content/50 uppercase tracking-wider mb-2">
						Include
					</p>
					<div class="flex flex-wrap gap-3">
						{#if albumCount > 0}
							<label class="label cursor-pointer gap-2 p-0">
								<input
									type="checkbox"
									class="checkbox checkbox-accent checkbox-sm"
									bind:checked={includeAlbums}
								/>
								<span class="label-text text-sm">Albums ({albumCount})</span>
							</label>
						{/if}
						{#if epCount > 0}
							<label class="label cursor-pointer gap-2 p-0">
								<input
									type="checkbox"
									class="checkbox checkbox-accent checkbox-sm"
									bind:checked={includeEPs}
								/>
								<span class="label-text text-sm">EPs ({epCount})</span>
							</label>
						{/if}
						{#if singleCount > 0}
							<label class="label cursor-pointer gap-2 p-0">
								<input
									type="checkbox"
									class="checkbox checkbox-accent checkbox-sm"
									bind:checked={includeSingles}
								/>
								<span class="label-text text-sm">Singles ({singleCount})</span>
							</label>
						{/if}
					</div>
				</div>
			{/if}

			{#if spotifyDiscography}
				<div class="mb-4">
					<div class="flex items-center justify-between mb-2">
						<p class="text-xs font-medium text-base-content/50 uppercase tracking-wider">
							{selectedTrackIds.length} of {discographyTracks.length} tracks selected
						</p>
						<button class="btn btn-ghost btn-xs" onclick={toggleAllTracks} disabled={loadingTracks}>
							{selectedTrackIds.length === discographyTracks.length ? 'Clear all' : 'Select all'}
						</button>
					</div>
					{#if loadingTracks}
						<div class="flex justify-center py-8">
							<span class="loading loading-spinner loading-lg"></span>
						</div>
					{:else if trackLoadError}
						<div class="alert alert-error">Could not load the Spotify tracks.</div>
					{:else}
						<div class="max-h-64 overflow-y-auto rounded-box border border-base-content/10">
							{#each discographyTracks as track (track.id)}
								<label class="flex items-center gap-3 px-3 py-2 hover:bg-base-200 cursor-pointer">
									<input
										type="checkbox"
										class="checkbox checkbox-accent checkbox-sm"
										checked={selectedTrackIds.includes(track.id)}
										onchange={() => toggleTrack(track.id)}
									/>
									<span class="w-8 text-xs text-base-content/50">{track.trackNumber}</span>
									<span class="flex-1 truncate">{track.title}</span>
									<span class="max-w-36 truncate text-xs text-base-content/50"
										>{track.albumTitle}</span
									>
									<span class="text-xs text-base-content/50"
										>{formatDuration(track.durationMs)}</span
									>
								</label>
							{/each}
						</div>
					{/if}
				</div>
			{:else if filteredReleases.length > 0}
				<div class="mb-4">
					<p class="text-xs font-medium text-base-content/50 uppercase tracking-wider mb-2">
						{filteredReleases.length} album{filteredReleases.length !== 1 ? 's' : ''} to request
					</p>
					<div
						class="grid gap-1.5 max-h-48 overflow-y-auto pr-1"
						style="grid-template-columns: repeat(auto-fill, minmax(3.5rem, 1fr));"
					>
						{#each filteredReleases.slice(0, 40) as release (release.id)}
							<div
								class="aspect-square rounded-lg overflow-hidden relative group"
								title={release.title}
							>
								<AlbumImage
									mbid={release.id}
									alt={release.title}
									size="sm"
									rounded="lg"
									className="w-full h-full"
								/>
								<div
									class="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
								>
									<span
										class="text-[0.6rem] text-white text-center px-1 line-clamp-2 leading-tight"
									>
										{release.title}
									</span>
								</div>
							</div>
						{/each}
						{#if filteredReleases.length > 40}
							<div class="aspect-square rounded-lg bg-base-300 flex items-center justify-center">
								<span class="text-xs text-base-content/50">+{filteredReleases.length - 40}</span>
							</div>
						{/if}
					</div>
				</div>
			{:else}
				<div class="bg-base-200/30 rounded-box p-4 text-center mb-4">
					<Library class="h-8 w-8 mx-auto text-base-content/30 mb-2" />
					<p class="text-sm text-base-content/50">
						{#if inLibraryCount === totalReleases}
							All releases are already in your library
						{:else}
							No releases to download with current filters
						{/if}
					</p>
				</div>
			{/if}

			{#if !spotifyDiscography}
				<div class="bg-base-200/50 rounded-box p-3 mb-4">
					<p class="text-xs font-medium text-base-content/50 uppercase tracking-wider mb-2">
						Options
					</p>
					<label class="label cursor-pointer justify-start gap-3 p-0 mb-1">
						<input
							type="checkbox"
							class="toggle toggle-accent toggle-sm"
							bind:checked={monitorArtist}
						/>
						<span class="label-text text-sm">Monitor artist for future releases</span>
					</label>
					{#if monitorArtist}
						<label class="label cursor-pointer justify-start gap-3 p-0 pl-10">
							<input
								type="checkbox"
								class="toggle toggle-accent toggle-sm"
								bind:checked={autoDownload}
							/>
							<span class="label-text text-sm">Auto-download new releases</span>
						</label>
					{/if}
				</div>
			{/if}

			<div class="modal-action mt-0">
				<button class="btn btn-ghost" onclick={handleClose} disabled={submitting}>Cancel</button>
				<button
					class="btn btn-accent"
					onclick={handleDownload}
					disabled={submitting ||
						(spotifyDiscography
							? loadingTracks || selectedTrackIds.length === 0
							: filteredReleases.length === 0)}
				>
					{#if submitting}
						<span class="loading loading-spinner loading-sm"></span>
						Requesting...
					{:else}
						<Download class="h-4 w-4" />
						{spotifyDiscography
							? `Request ${selectedTrackIds.length} track${selectedTrackIds.length === 1 ? '' : 's'}`
							: `Download ${filteredReleases.length} Album${filteredReleases.length !== 1 ? 's' : ''}`}
					{/if}
				</button>
			</div>
		</div>
		<form method="dialog" class="modal-backdrop">
			<button>close</button>
		</form>
	</dialog>
{/if}
