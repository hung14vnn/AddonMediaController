<script lang="ts">
	import { goto } from '$app/navigation';
	import { ArrowLeft, Link2, Loader2, Music2 } from 'lucide-svelte';
	import SpotifyIcon from '$lib/components/SpotifyIcon.svelte';
	import { createImportSpotifyPlaylistMutation } from '$lib/queries/spotify/SpotifyQueries.svelte';
	import { toastStore } from '$lib/stores/toast';
	import { withBasePath } from '$lib/utils/basePath';

	const importMutation = createImportSpotifyPlaylistMutation();
	let playlistUrl = $state('');

	async function importPlaylist() {
		const url = playlistUrl.trim();
		if (!url || importMutation.isPending) return;
		try {
			const result = await importMutation.mutateAsync({ url });
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
	<title>Import from Spotify</title>
</svelte:head>

<div class="space-y-6 px-4 sm:px-6 lg:px-8">
	<div class="flex items-center gap-3">
		<a href={withBasePath('/playlists')} class="btn btn-ghost btn-sm btn-circle" aria-label="Back">
			<ArrowLeft class="h-4 w-4" />
		</a>
		<h1 class="flex min-w-0 flex-1 items-center gap-2 text-2xl font-bold sm:text-3xl">
			<SpotifyIcon class="h-6 w-6 shrink-0 text-green-400" />
			Import from Spotify
		</h1>
	</div>

	<div class="mx-auto flex max-w-xl flex-col items-center gap-5 py-16 text-center">
		<div class="flex h-16 w-16 items-center justify-center rounded-2xl bg-green-500/10 text-green-400 ring-1 ring-green-500/20">
			<Music2 class="h-8 w-8" />
		</div>
		<div>
			<h2 class="text-xl font-semibold">Import a public playlist</h2>
			<p class="mt-2 text-sm text-base-content/60">
				Paste a Spotify playlist URL to copy it into your library. Private playlists are not supported.
			</p>
		</div>
		<form
			class="w-full space-y-3 text-left"
			onsubmit={(event) => { event.preventDefault(); void importPlaylist(); }}
		>
			<label class="input input-bordered flex w-full items-center gap-2">
				<Link2 class="h-4 w-4 text-base-content/50" />
				<input
					bind:value={playlistUrl}
					type="url"
					placeholder="https://open.spotify.com/playlist/..."
					aria-label="Spotify playlist URL"
					required
				/>
			</label>
			<button
				class="btn w-full bg-green-600 text-white hover:bg-green-500"
				type="submit"
				disabled={!playlistUrl.trim() || importMutation.isPending}
			>
				{#if importMutation.isPending}
					<Loader2 class="h-4 w-4 animate-spin" />
				{:else}
					<SpotifyIcon class="h-4 w-4" />
				{/if}
				Import playlist
			</button>
		</form>
	</div>
	<!-- Upstream Spotify playlist grid is not applicable to this fork's import-only page.
			</div>
		</div>
	{:else if (playlistsQuery.data?.playlists ?? []).length === 0}
		<div class="flex flex-col items-center justify-center gap-4 py-20">
			<SpotifyIcon class="h-16 w-16 text-base-content/20" />
			<p class="text-base-content/50">No Spotify playlists found.</p>
		</div>
	{:else}
		<div class={gridClass}>
			{#each playlistsQuery.data?.playlists ?? [] as playlist (playlist.id)}
				{@const isImporting = importing === playlist.id}
				{@const alreadyImported = !!playlist.imported_playlist_id}
				<div class="group flex flex-col gap-2">
					<div class="relative aspect-square overflow-hidden rounded-2xl bg-base-300/60">
						{#if playlist.cover_url}
							<img
								src={getApiUrl(playlist.cover_url)}
								alt={playlist.name}
								class="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
							/>
						{:else}
							<div class="flex h-full w-full items-center justify-center">
								<Music2 class="h-10 w-10 text-base-content/20" />
							</div>
						{/if}

						{#if alreadyImported}
							<div
								class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60 opacity-0 transition-opacity group-hover:opacity-100"
							>
								<a
									href={withBasePath(`/playlists/${playlist.imported_playlist_id}`)}
									class="btn btn-sm btn-ghost rounded-full text-white"
								>
									View Playlist
								</a>
								<button
									class="btn btn-xs gap-1 rounded-full bg-white/20 text-white hover:bg-white/30"
									onclick={() => void handleImport(playlist)}
									disabled={!!importing}
								>
									{#if isImporting}
										<LoaderCircle class="h-3 w-3 animate-spin" />
									{:else}
										<RefreshCw class="h-3 w-3" />
									{/if}
									Re-import
								</button>
							</div>
						{:else}
							<button
								class="absolute inset-0 flex items-center justify-center bg-black/60 opacity-0 transition-opacity group-hover:opacity-100 disabled:cursor-not-allowed"
								onclick={() => void handleImport(playlist)}
								disabled={!!importing}
							>
								{#if isImporting}
									<LoaderCircle class="h-8 w-8 animate-spin text-white" />
								{:else}
									<div class="flex flex-col items-center gap-1 rounded-xl px-3 py-2 text-white">
										<SpotifyIcon class="h-6 w-6 text-green-400" />
										<span class="text-xs font-semibold">Import</span>
									</div>
								{/if}
							</button>
						{/if}

						{#if alreadyImported && !isImporting}
							<div
								class="absolute right-2 top-2 rounded-full bg-green-600 p-0.5 shadow group-hover:opacity-0 transition-opacity"
							>
								<CircleCheckBig class="h-4 w-4 text-white" />
							</div>
						{/if}
					</div>

					<div class="min-w-0 px-0.5">
						<p class="truncate text-sm font-semibold leading-tight">{playlist.name}</p>
						{#if playlist.owner}
							<p class="truncate text-xs text-base-content/40">{playlist.owner}</p>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	{/if}
	-->
</div>
