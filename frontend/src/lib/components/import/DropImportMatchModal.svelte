<script lang="ts">
	import { untrack } from 'svelte';
	import { Disc3, Library, Search, X } from 'lucide-svelte';
	import AlbumImage from '$lib/components/AlbumImage.svelte';
	import {
		getAlbumSearchQuery,
		getLibraryAlbumTracksQuery,
		getLibrarySearchQuery
	} from '$lib/queries/library/LibraryQueries.svelte';
	import { matchDropItemMutation } from '$lib/queries/import/DropImportMutations.svelte';
	import type { DropImportItem } from '$lib/queries/import/types';
	import type {
		Album,
		LibraryAlbumSummary,
		LibraryArtistSummary,
		NativeTrackListItem
	} from '$lib/types';

	interface Props {
		item: DropImportItem;
		onclose: () => void;
	}
	let { item, onclose }: Props = $props();
	let dialogEl = $state<HTMLDialogElement | null>(null);
	let mode = $state<'library' | 'catalog'>('library');
	let searchTerm = $state(untrack(() => item.folder_name.replace(/[-_]/g, ' ').trim()));
	let trackTitle = $state(untrack(() => item.folder_name.replace(/[-_]/g, ' ').trim()));
	let albumTitle = $state(untrack(() => item.album_title ?? ''));
	let artistName = $state(untrack(() => item.artist_name ?? ''));
	let selectedAlbumId = $state('');
	let selectedTrackId = $state('');

	const librarySearch = getLibrarySearchQuery(() => searchTerm);
	const catalogSearch = getAlbumSearchQuery(() => searchTerm);
	const albumTracks = getLibraryAlbumTracksQuery(() => selectedAlbumId);
	const match = matchDropItemMutation();
	const localResults = $derived(librarySearch.data);
	const tracks = $derived(albumTracks.data?.items ?? []);

	$effect(() => {
		dialogEl?.showModal();
	});

	function selectArtist(artist: LibraryArtistSummary) {
		artistName = artist.name;
		searchTerm = artist.name;
		selectedAlbumId = '';
		selectedTrackId = '';
	}
	function selectAlbum(album: LibraryAlbumSummary) {
		selectedAlbumId = album.id;
		selectedTrackId = '';
		albumTitle = album.title;
		artistName = album.artist_name;
	}
	function selectTrack(track: NativeTrackListItem) {
		selectedAlbumId = track.album_id;
		selectedTrackId = track.id;
		trackTitle = track.title;
		albumTitle = track.album_title;
		artistName = track.album_artist_name || track.artist_name;
	}
	function clearSelection() {
		selectedAlbumId = '';
		selectedTrackId = '';
	}
	async function submitManual() {
		if (match.isPending || !trackTitle.trim() || !albumTitle.trim() || !artistName.trim()) return;
		try {
			await match.mutateAsync({
				itemId: item.id,
				libraryAlbumId: selectedAlbumId || undefined,
				libraryTrackId: selectedTrackId || undefined,
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
				class:tab-active={mode === 'library'}
				class="tab gap-2"
				onclick={() => (mode = 'library')}><Library class="h-4 w-4" /> Manual / library</button
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
				placeholder={mode === 'library' ? 'Search your library…' : 'Search MusicBrainz…'}
				bind:value={searchTerm}
			/>
			{#if mode === 'library' ? librarySearch.isFetching : catalogSearch.isFetching}<span
					class="loading loading-spinner loading-xs"
				></span>{/if}
		</label>

		{#if mode === 'library'}
			<div class="mt-3 max-h-48 overflow-y-auto rounded-lg border border-base-300">
				{#each localResults?.artists ?? [] as artist (artist.id)}
					<button
						class="flex w-full items-center justify-between p-2 text-left hover:bg-base-200"
						onclick={() => selectArtist(artist)}
						><span class="truncate text-sm">{artist.name}</span><span
							class="badge badge-ghost badge-sm">Artist</span
						></button
					>
				{/each}
				{#each localResults?.albums ?? [] as album (album.id)}
					<button
						class="flex w-full items-center justify-between p-2 text-left hover:bg-base-200"
						onclick={() => selectAlbum(album)}
						><span class="min-w-0"
							><span class="block truncate text-sm">{album.title}</span><span
								class="block truncate text-xs opacity-55">{album.artist_name}</span
							></span
						><span class="badge badge-ghost badge-sm">Album</span></button
					>
				{/each}
				{#each localResults?.tracks ?? [] as track (track.id)}
					<button
						class="flex w-full items-center justify-between p-2 text-left hover:bg-base-200"
						onclick={() => selectTrack(track)}
						><span class="min-w-0"
							><span class="block truncate text-sm">{track.title}</span><span
								class="block truncate text-xs opacity-55"
								>{track.artist_name} · {track.album_title}</span
							></span
						><span class="badge badge-ghost badge-sm">Track</span></button
					>
				{/each}
				{#if searchTerm.trim().length >= 2 && !librarySearch.isFetching && !(localResults?.artists.length || localResults?.albums.length || localResults?.tracks.length)}<p
						class="p-3 text-sm opacity-50"
					>
						No library matches. You can create local metadata below.
					</p>{/if}
			</div>
			{#if selectedAlbumId}
				<div class="mt-3">
					<p class="mb-1 text-xs font-semibold uppercase opacity-50">Tracks in selected album</p>
					<div class="max-h-32 overflow-y-auto rounded-lg border border-base-300">
						{#each tracks as track (track.id)}<button
								class="flex w-full gap-2 p-2 text-left text-sm hover:bg-base-200"
								class:bg-primary={selectedTrackId === track.id}
								class:text-primary-content={selectedTrackId === track.id}
								onclick={() => selectTrack(track)}
								><span class="w-8 opacity-60">{track.disc_number}.{track.track_number}</span><span
									class="truncate">{track.title}</span
								></button
							>{/each}
					</div>
				</div>
			{/if}
			<div class="mt-4 grid gap-3 sm:grid-cols-2">
				<label class="form-control sm:col-span-2"
					><span class="label-text mb-1">Track name</span><input
						class="input input-bordered w-full"
						bind:value={trackTitle}
						disabled={!!selectedTrackId}
					/></label
				>
				<label class="form-control"
					><span class="label-text mb-1">Album</span><input
						class="input input-bordered w-full"
						bind:value={albumTitle}
						disabled={!!selectedAlbumId}
					/></label
				>
				<label class="form-control"
					><span class="label-text mb-1">Artist</span><input
						class="input input-bordered w-full"
						bind:value={artistName}
						disabled={!!selectedAlbumId}
					/></label
				>
			</div>
			<p class="mt-2 text-xs opacity-55">
				{#if selectedTrackId}This file will map directly to the selected track.{:else if selectedAlbumId}If
					the track name is not already in this album, it will be added as a new track.{:else}A new
					local-only artist/album will be created.{/if}
			</p>
			{#if selectedAlbumId}
				<button class="btn btn-ghost btn-xs mt-1" onclick={clearSelection}
					>Use new local metadata instead</button
				>
			{/if}
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
						><AlbumImage
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
						</div></button
					>
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
