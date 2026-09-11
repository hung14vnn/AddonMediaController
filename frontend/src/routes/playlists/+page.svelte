<script lang="ts">
	import { goto } from '$app/navigation';
	import {
		isRedactedPlaylist,
		type PlaylistListItem,
		type PlaylistSummary,
		type RedactedPlaylist
	} from '$lib/api/playlists';
	import { toastStore } from '$lib/stores/toast';
	import { authStore } from '$lib/stores/authStore.svelte';
	import { getPlaylistListQuery } from '$lib/queries/playlists/PlaylistQuery.svelte';
	import { createCreatePlaylistMutation } from '$lib/queries/playlists/PlaylistMutations.svelte';
	import { createImportSpotifyPlaylistMutation } from '$lib/queries/spotify/SpotifyQueries.svelte';
	import { withBasePath } from '$lib/utils/basePath';
	import { Link2, ListMusic, Loader2, Plus, Lock, X } from 'lucide-svelte';
	import SpotifyIcon from '$lib/components/SpotifyIcon.svelte';
	import PlaylistCard from '$lib/components/PlaylistCard.svelte';
	import RedactedPlaylistCard from '$lib/components/RedactedPlaylistCard.svelte';
	import PlaylistCardSkeleton from '$lib/components/PlaylistCardSkeleton.svelte';

	const query = getPlaylistListQuery(() => authStore.isAuthenticated);
	const createMutation = createCreatePlaylistMutation();
	const importSpotifyMutation = createImportSpotifyPlaylistMutation();

	let items = $derived((query.data ?? []) as PlaylistListItem[]);
	let localPlaylists = $derived(
		items.filter((p): p is PlaylistSummary => !isRedactedPlaylist(p) && p.is_owner && !p.source_ref)
	);
	let importedPlaylists = $derived(
		items.filter(
			(p): p is PlaylistSummary => !isRedactedPlaylist(p) && p.is_owner && !!p.source_ref
		)
	);
	let sharedPlaylists = $derived(
		items.filter((p): p is PlaylistSummary => !isRedactedPlaylist(p) && !p.is_owner)
	);
	let redactedPlaylists = $derived(items.filter(isRedactedPlaylist) as RedactedPlaylist[]);
	let errorMessage = $derived(
		query.isError
			? query.error instanceof Error
				? query.error.message
				: "Couldn't load playlists"
			: null
	);

	let showNewInput = $state(false);
	let newName = $state('');
	let newNameInputEl = $state<HTMLInputElement | null>(null);
	let showSpotifyImport = $state(false);
	let spotifyPlaylistUrl = $state('');

	$effect(() => {
		if (showNewInput && newNameInputEl) {
			newNameInputEl.focus();
		}
	});

	const gridClass =
		'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4';

	async function handleCreate() {
		const trimmed = newName.trim();
		if (!trimmed || createMutation.isPending) return;
		try {
			const created = await createMutation.mutateAsync(trimmed);
			newName = '';
			showNewInput = false;
			await goto(withBasePath(`/playlists/${created.id}`));
		} catch (_e) {
			toastStore.show({ message: "Couldn't create the playlist", type: 'error' });
		}
	}

	function handleCreateKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') void handleCreate();
		if (e.key === 'Escape') {
			showNewInput = false;
			newName = '';
		}
	}

	function handleCardDelete() {
		void query.refetch();
	}

	async function handleSpotifyImport() {
		const url = spotifyPlaylistUrl.trim();
		if (!url || importSpotifyMutation.isPending) return;
		try {
			const result = await importSpotifyMutation.mutateAsync({ url });
			showSpotifyImport = false;
			spotifyPlaylistUrl = '';
			toastStore.show({ message: 'Playlist is importing in the background', type: 'success' });
			await goto(withBasePath(`/playlists/${result.playlist_id}`));
		} catch (error) {
			toastStore.show({
				message: error instanceof Error ? error.message : 'Failed to import Spotify playlist',
				type: 'error'
			});
		}
	}
</script>

<svelte:head>
	<title>Playlists</title>
</svelte:head>

<div class="space-y-6 px-4 pb-12 sm:px-6 sm:pb-16 lg:px-8">
	<div class="flex items-center justify-between gap-3">
		<h1 class="text-2xl font-bold sm:text-3xl">Playlists</h1>
		<div class="flex items-center gap-2">
			<button
				type="button"
					class="btn btn-sm gap-1.5 bg-green-600 text-white hover:bg-green-500"
					onclick={() => (showSpotifyImport = true)}
				>
					<SpotifyIcon class="h-3.5 w-3.5" />
					<span class="sm:hidden">Import</span>
					<span class="hidden sm:inline">Import from Spotify</span>
			</button>
			<button
				class="btn btn-accent btn-sm"
				onclick={() => {
					showNewInput = true;
				}}
			>
				<Plus class="h-4 w-4" />
				<span class="sm:hidden">New</span>
				<span class="hidden sm:inline">New Local Playlist</span>
			</button>
		</div>
	</div>

	{#if showNewInput}
		<div class="flex items-center gap-2">
			<input
				type="text"
				class="input input-sm flex-1"
				placeholder="Playlist name..."
				bind:this={newNameInputEl}
				bind:value={newName}
				onkeydown={handleCreateKeydown}
			/>
			<button
				class="btn btn-accent btn-sm"
				onclick={() => void handleCreate()}
				disabled={!newName.trim() || createMutation.isPending}
			>
				{#if createMutation.isPending}
					<span class="loading loading-spinner loading-xs"></span>
				{:else}
					Create
				{/if}
			</button>
			<button
				class="btn btn-ghost btn-sm"
				onclick={() => {
					showNewInput = false;
					newName = '';
				}}
			>
				Cancel
			</button>
		</div>
	{/if}

	{#if query.isLoading}
		<div class={gridClass}>
			{#each Array(8) as _, i (`skeleton-${i}`)}
				<PlaylistCardSkeleton />
			{/each}
		</div>
	{:else if errorMessage}
		<div role="alert" class="alert alert-error">
			<span>{errorMessage}</span>
			<button class="btn btn-sm btn-ghost" onclick={() => void query.refetch()}>Retry</button>
		</div>
	{:else if items.length === 0}
		<div class="flex flex-col items-center justify-center py-20 gap-4">
			<ListMusic class="h-16 w-16 text-base-content/20" />
			<h2 class="text-lg font-semibold text-base-content/60">No playlists yet</h2>
			<button
				class="btn btn-accent btn-sm"
				onclick={() => {
					showNewInput = true;
				}}
			>
				<Plus class="h-4 w-4" />
				Create your first playlist
			</button>
		</div>
	{:else}
		{#if localPlaylists.length > 0}
			<section class="space-y-3">
				<h2 class="text-sm font-semibold uppercase tracking-wider text-base-content/60">
					Local Playlists
				</h2>
				<div class={gridClass}>
					{#each localPlaylists as playlist (playlist.id)}
						<PlaylistCard {playlist} ondelete={handleCardDelete} />
					{/each}
				</div>
			</section>
		{/if}

		{#if importedPlaylists.length > 0}
			<section class="space-y-3">
				<div>
					<h2 class="text-sm font-semibold uppercase tracking-wider text-base-content/60">
						Imported Playlists
					</h2>
					<p class="mt-1 text-xs text-base-content/45">
						Used to find and import music; playback is available from local playlists.
					</p>
				</div>
				<div class={gridClass}>
					{#each importedPlaylists as playlist (playlist.id)}
						<PlaylistCard {playlist} ondelete={handleCardDelete} />
					{/each}
				</div>
			</section>
		{/if}

		{#if sharedPlaylists.length > 0}
			<section class="space-y-3">
				<h2 class="text-sm font-semibold uppercase tracking-wider text-base-content/60">
					Shared with you
				</h2>
				<div class={gridClass}>
					{#each sharedPlaylists as playlist (playlist.id)}
						<PlaylistCard {playlist} ondelete={handleCardDelete} />
					{/each}
				</div>
			</section>
		{/if}

		{#if redactedPlaylists.length > 0}
			<section class="space-y-3">
				<h2
					class="flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wider text-base-content/40"
				>
					<Lock class="h-3.5 w-3.5" />
					Private &middot; admin view
				</h2>
				<div class={gridClass}>
					{#each redactedPlaylists as playlist (playlist.id)}
						<RedactedPlaylistCard {playlist} />
					{/each}
				</div>
			</section>
		{/if}
	{/if}
</div>

{#if showSpotifyImport}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="presentation" onclick={(event) => event.target === event.currentTarget && (showSpotifyImport = false)}>
		<div class="w-full max-w-lg rounded-2xl border border-base-300 bg-base-100 p-6 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="spotify-import-title">
			<div class="mb-5 flex items-center justify-between gap-4">
				<div>
					<h2 id="spotify-import-title" class="text-lg font-semibold">Import from Spotify</h2>
					<p class="mt-1 text-sm text-base-content/60">Paste a public playlist URL.</p>
				</div>
				<button class="btn btn-ghost btn-sm btn-circle" type="button" aria-label="Close" onclick={() => (showSpotifyImport = false)}>
					<X class="h-4 w-4" />
				</button>
			</div>
			<form class="space-y-4" onsubmit={(event) => { event.preventDefault(); void handleSpotifyImport(); }}>
				<label class="input input-bordered flex w-full items-center gap-2">
					<Link2 class="h-4 w-4 text-base-content/50" />
					<input bind:value={spotifyPlaylistUrl} type="url" required aria-label="Spotify playlist URL" placeholder="https://open.spotify.com/playlist/..." />
				</label>
				<button class="btn w-full bg-green-600 text-white hover:bg-green-500" type="submit" disabled={!spotifyPlaylistUrl.trim() || importSpotifyMutation.isPending}>
					{#if importSpotifyMutation.isPending}<Loader2 class="h-4 w-4 animate-spin" />{:else}<SpotifyIcon class="h-4 w-4" />{/if}
					Import playlist
				</button>
			</form>
		</div>
	</div>
{/if}
