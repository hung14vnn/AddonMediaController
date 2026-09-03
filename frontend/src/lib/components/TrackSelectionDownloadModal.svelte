<script lang="ts">
	import { Check, Download, Loader2, X } from 'lucide-svelte';
	import { api } from '$lib/api/client';
	import { API } from '$lib/constants';
	import type { AlbumTracksInfo } from '$lib/types';
	import { trackSelectionDownloadStore } from '$lib/stores/trackSelectionDownload.svelte';
	import { requestSpotifyTracks } from '$lib/queries/downloads/DownloadMutations.svelte';
	import { formatDuration } from '$lib/utils/formatting';

	let dialogEl: HTMLDialogElement | undefined = $state();
	let selectedIds = $state<string[]>([]);
	let loading = $state(false);
	let loadError = $state(false);

	const request = requestSpotifyTracks();

	$effect(() => {
		if (!trackSelectionDownloadStore.open) return;
		selectedIds = trackSelectionDownloadStore.tracks.map((track) => track.id);
		loadError = false;
		if (dialogEl && !dialogEl.open) dialogEl.showModal();

		if (trackSelectionDownloadStore.tracks.length > 0) return;
		loading = true;
		void api.global
			.get<AlbumTracksInfo>(API.album.tracks(trackSelectionDownloadStore.albumId))
			.then((data) => {
				const tracks = data.tracks
					.filter((track) => track.recording_id?.startsWith('spotify:track:'))
					.map((track) => ({
						id: track.recording_id!.slice('spotify:track:'.length),
						title: track.title,
						trackNumber: track.position,
						discNumber: track.disc_number ?? 1,
						durationMs: track.length
					}));
				trackSelectionDownloadStore.setTracks(tracks);
				selectedIds = tracks.map((track) => track.id);
			})
			.catch(() => (loadError = true))
			.finally(() => (loading = false));
	});

	function close() {
		dialogEl?.close();
		trackSelectionDownloadStore.close();
	}

	function toggle(id: string) {
		selectedIds = selectedIds.includes(id)
			? selectedIds.filter((selected) => selected !== id)
			: [...selectedIds, id];
	}

	function toggleAll() {
		selectedIds =
			selectedIds.length === trackSelectionDownloadStore.tracks.length
				? []
				: trackSelectionDownloadStore.tracks.map((track) => track.id);
	}

	async function submit() {
		if (selectedIds.length === 0 || request.isPending) return;
		const result = await request.mutateAsync(selectedIds).catch(() => null);
		if (result) close();
	}
</script>

{#if trackSelectionDownloadStore.open}
	<dialog bind:this={dialogEl} class="modal" onclose={close}>
		<div class="modal-box max-w-2xl">
			<div class="flex items-center justify-between mb-4">
				<div>
					<h3 class="text-lg font-bold">Choose tracks to download</h3>
					<p class="text-sm text-base-content/60">
						{trackSelectionDownloadStore.albumTitle} · {trackSelectionDownloadStore.artistName}
					</p>
				</div>
				<button class="btn btn-ghost btn-sm btn-circle" onclick={close} aria-label="Close">
					<X class="h-4 w-4" />
				</button>
			</div>

			{#if loading}
				<div class="flex justify-center py-10">
					<span class="loading loading-spinner loading-lg"></span>
				</div>
			{:else if loadError}
				<div class="alert alert-error">Could not load this album's tracks.</div>
			{:else if trackSelectionDownloadStore.tracks.length === 0}
				<div class="alert alert-warning">No Spotify tracks are available for this album.</div>
			{:else}
				<div class="flex items-center justify-between mb-2">
					<span class="text-sm text-base-content/60"
						>{selectedIds.length} of {trackSelectionDownloadStore.tracks.length} selected</span
					>
					<button class="btn btn-ghost btn-xs" onclick={toggleAll}>
						{selectedIds.length === trackSelectionDownloadStore.tracks.length
							? 'Clear all'
							: 'Select all'}
					</button>
				</div>
				<div class="max-h-96 overflow-y-auto rounded-box border border-base-content/10">
					{#each trackSelectionDownloadStore.tracks as track (track.id)}
						<label class="flex items-center gap-3 px-3 py-2 hover:bg-base-200 cursor-pointer">
							<input
								type="checkbox"
								class="checkbox checkbox-accent checkbox-sm"
								checked={selectedIds.includes(track.id)}
								onchange={() => toggle(track.id)}
							/>
							<span class="w-8 text-xs text-base-content/50">{track.trackNumber}</span>
							<span class="flex-1 truncate">{track.title}</span>
							<span class="text-xs text-base-content/50">{formatDuration(track.durationMs)}</span>
						</label>
					{/each}
				</div>
			{/if}

			<div class="modal-action mt-5">
				<button class="btn btn-ghost" onclick={close} disabled={request.isPending}>Cancel</button>
				<button
					class="btn btn-accent"
					onclick={submit}
					disabled={loading || selectedIds.length === 0 || request.isPending}
				>
					{#if request.isPending}
						<Loader2 class="h-4 w-4 animate-spin" /> Requesting...
					{:else}
						<Download class="h-4 w-4" /> Request {selectedIds.length} tracks
					{/if}
				</button>
			</div>
		</div>
		<form method="dialog" class="modal-backdrop"><button>close</button></form>
	</dialog>
{/if}
