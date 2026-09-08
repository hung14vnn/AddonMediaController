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
</div>
