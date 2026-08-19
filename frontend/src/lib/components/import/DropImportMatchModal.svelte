<script lang="ts">
	import { untrack } from 'svelte';
	import { createQuery } from '@tanstack/svelte-query';
	import { Disc3, Library, Search, X } from 'lucide-svelte';
	import AlbumImage from '$lib/components/AlbumImage.svelte';
	import { api } from '$lib/api/client';
	import { API } from '$lib/constants';
	import { getAlbumSearchQuery } from '$lib/queries/library/LibraryQueries.svelte';
	import { matchDropItemMutation } from '$lib/queries/import/DropImportMutations.svelte';
	import type { DropImportItem } from '$lib/queries/import/types';
	import type { Album, SpotifyTrackResult } from '$lib/types';

	interface Props {
		item: DropImportItem;
		onclose: () => void;
	}
	let { item, onclose }: Props = $props();
	let dialogEl = $state<HTMLDialogElement | null>(null);
	let mode = $state<'spotify' | 'catalog'>('spotify');
	let searchTerm = $state(
		untrack(() =>
			item.folder_name === 'Loose tracks' ? '' : item.folder_name.replace(/[-_]/g, ' ').trim()
		)
	);
	let trackTitle = $state(
		untrack(() =>
			item.folder_name === 'Loose tracks' ? '' : item.folder_name.replace(/[-_]/g, ' ').trim()
		)
	);
	let albumTitle = $state(untrack(() => item.album_title ?? ''));
	let artistName = $state(untrack(() => item.artist_name ?? ''));
	let selectedSpotifyTrack = $state<SpotifyTrackResult | null>(null);

	const spotifySearch = createQuery(() => {
		const term = searchTerm.trim();
		return {
			enabled: term.length >= 2,
			queryKey: ['drop-import', 'spotify-track-search', term],
			queryFn: async ({ signal }) => {
				const data = await api.global.get<{ tracks?: SpotifyTrackResult[] }>(
					API.search.tracks(term),
					{ signal }
				);
				return data.tracks ?? [];
			}
		};
	});
	const catalogSearch = getAlbumSearchQuery(() => searchTerm);
	const match = matchDropItemMutation();

	$effect(() => {
		dialogEl?.showModal();
	});

	function selectSpotifyTrack(track: SpotifyTrackResult) {
		selectedSpotifyTrack = track;
		trackTitle = track.title;
		albumTitle = track.album;
		artistName = track.artist;
	}
	async function submitManual() {
		if (match.isPending || !trackTitle.trim() || !albumTitle.trim() || !artistName.trim()) return;
		try {
			await match.mutateAsync({
				itemId: item.id,
				trackTitle: trackTitle.trim(),
				albumTitle: albumTitle.trim(),
				artistName: artistName.trim()
			});
			onclose();
		} catch {
			/* mutation owns the error toast */
		}
	}
	async function pickCatalog(album: Album) {
		if (match.isPending) return;
		try {
			await match.mutateAsync({ itemId: item.id, releaseGroupMbid: album.musicbrainz_id });
			onclose();
		} catch {
			/* mutation owns the error toast */
		}
	}
</script>

<dialog bind:this={dialogEl} class="modal" {onclose}>
	<div class="modal-box max-w-2xl">
		<div class="flex items-start justify-between gap-3">
			<div class="min-w-0">
				<h3 class="text-lg font-bold">Review import metadata</h3>
				<p class="truncate text-xs text-base-content/50" title={item.folder_name}>
					{item.folder_name} · {item.files_total} file{item.files_total === 1 ? '' : 's'}
				</p>
			</div>
			<button
				class="btn btn-ghost btn-sm btn-circle"
				onclick={() => dialogEl?.close()}
				aria-label="Close"><X class="h-5 w-5" /></button
			>
		</div>
		<div class="tabs tabs-box mt-4">
			<button
				class:tab-active={mode === 'spotify'}
				class="tab gap-2"
				onclick={() => (mode = 'spotify')}><Library class="h-4 w-4" /> Manual / Spotify</button
			>
			<button
				class:tab-active={mode === 'catalog'}
				class="tab gap-2"
				onclick={() => (mode = 'catalog')}><Disc3 class="h-4 w-4" /> MusicBrainz album</button
			>
		</div>
		<label class="input input-bordered mt-4 flex w-full items-center gap-2">
			<Search class="h-4 w-4 opacity-50" /><input
				type="text"
				class="grow"
				placeholder={mode === 'spotify' ? 'Search Spotify…' : 'Search MusicBrainz…'}
				bind:value={searchTerm}
			/>
			{#if mode === 'spotify' ? spotifySearch.isFetching : catalogSearch.isFetching}<span
					class="loading loading-spinner loading-xs"
				></span>{/if}
		</label>

		{#if mode === 'spotify'}
			<div class="mt-3 max-h-48 overflow-y-auto rounded-lg border border-base-300">
				{#each spotifySearch.data ?? [] as track (track.spotify_id)}
					<button
						class="flex w-full items-center justify-between p-2 text-left hover:bg-base-200"
						class:bg-primary={selectedSpotifyTrack?.spotify_id === track.spotify_id}
						class:text-primary-content={selectedSpotifyTrack?.spotify_id === track.spotify_id}
						onclick={() => selectSpotifyTrack(track)}
					>
						<span class="min-w-0"
							><span class="block truncate text-sm">{track.title}</span><span
								class="block truncate text-xs opacity-55">{track.artist} · {track.album}</span
							></span
						>
						<span class="badge badge-ghost badge-sm">Spotify</span>
					</button>
				{/each}
				{#if searchTerm.trim().length >= 2 && !spotifySearch.isFetching && !spotifySearch.data?.length}
					<p class="p-3 text-sm opacity-50">
						No Spotify tracks found. You can create local metadata below.
					</p>
				{/if}
			</div>
			<div class="mt-4 grid gap-3 sm:grid-cols-2">
				<label class="form-control sm:col-span-2"
					><span class="label-text mb-1">Track name</span><input
						class="input input-bordered w-full"
						bind:value={trackTitle}
					/></label
				>
				<label class="form-control"
					><span class="label-text mb-1">Album</span><input
						class="input input-bordered w-full"
						bind:value={albumTitle}
					/></label
				>
				<label class="form-control"
					><span class="label-text mb-1">Artist</span><input
						class="input input-bordered w-full"
						bind:value={artistName}
					/></label
				>
			</div>
			<p class="mt-2 text-xs opacity-55">
				{#if selectedSpotifyTrack}Spotify metadata has been copied to the fields below. You can
					adjust it before importing.{:else}A new local-only artist/album will be created.{/if}
			</p>
			<div class="modal-action">
				<button
					class="btn btn-primary"
					disabled={match.isPending ||
						!trackTitle.trim() ||
						!albumTitle.trim() ||
						!artistName.trim()}
					onclick={submitManual}
					>{#if match.isPending}<span class="loading loading-spinner loading-sm"
						></span>{/if}Import</button
				>
			</div>
		{:else}
			<div class="mt-3 max-h-72 space-y-1 overflow-y-auto">
				{#each catalogSearch.data ?? [] as album (album.musicbrainz_id)}
					<button
						class="flex w-full items-center gap-3 rounded-lg p-2 text-left hover:bg-base-200"
						onclick={() => pickCatalog(album)}
						disabled={match.isPending}
					>
						<AlbumImage
							mbid={album.musicbrainz_id}
							size="xs"
							rounded="sm"
							className="h-10 w-10 shrink-0"
							alt=""
						/>
						<div class="min-w-0">
							<p class="truncate text-sm font-medium">{album.title}</p>
							<p class="truncate text-xs opacity-55">
								{album.artist || 'Unknown artist'}{album.year ? ` · ${album.year}` : ''}
							</p>
						</div>
					</button>
				{:else}
					{#if searchTerm.trim().length >= 2 && !catalogSearch.isFetching}
						<p class="p-2 text-sm opacity-50">No MusicBrainz albums found.</p>
					{/if}
				{/each}
			</div>
		{/if}
	</div>
	<form method="dialog" class="modal-backdrop"><button aria-label="Close">close</button></form>
</dialog>
