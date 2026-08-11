<script lang="ts">
	import { Download } from 'lucide-svelte';
	import type { SpotifyTrackResult } from '$lib/types';
	import { requestSpotifyTrack } from '$lib/queries/downloads/DownloadMutations.svelte';

	let {
		tracks,
		title = 'Spotify tracks',
		variant = 'list'
	}: { tracks: SpotifyTrackResult[]; title?: string; variant?: 'list' | 'grid' } = $props();
	const download = requestSpotifyTrack();
	let requested = $state<Set<string>>(new Set());

	function request(track: SpotifyTrackResult) {
		download.mutate(track.spotify_id, {
			onSuccess: () => (requested = new Set([...requested, track.spotify_id]))
		});
	}
</script>

<section class="mt-6">
	<h2 class="text-xl font-bold mb-4">{title}</h2>
	{#if tracks.length === 0}
		<div class="rounded-box bg-base-200 p-6 text-center text-sm text-base-content/60">
			No Spotify tracks found.
		</div>
	{:else if variant === 'grid'}
		<div class="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
			{#each tracks as track (track.spotify_id)}
				<div
					class="group relative overflow-hidden rounded-box bg-base-200 transition-transform hover:-translate-y-0.5 hover:bg-base-300"
				>
					<a
						href={track.spotify_url ?? `https://open.spotify.com/track/${track.spotify_id}`}
						target="_blank"
						rel="noreferrer"
					>
						{#if track.album_image_url}
							<img src={track.album_image_url} alt="" class="aspect-square w-full object-cover" />
						{:else}<div class="aspect-square w-full bg-base-300"></div>{/if}
						<div class="card-body p-3">
							<h2 class="card-title line-clamp-2 min-h-[2.5rem] text-sm">{track.title}</h2>
							<p class="line-clamp-1 text-xs opacity-70">
								{track.artist}
								{#if track.album}
									<span class="mx-1 opacity-50">&bull;</span>
									{track.album}
								{/if}
							</p>
						</div>
					</a>
					<button
						class="btn btn-square btn-md absolute bottom-2 right-2 z-20 border-none bg-accent text-accent-content opacity-0 shadow-lg transition-opacity duration-200 group-hover:opacity-100 group-focus-within:opacity-100"
						onclick={() => request(track)}
						disabled={download.isPending || requested.has(track.spotify_id)}
						aria-label="Request this track"
						title="Request this track"
					>
						{#if download.isPending}
							<span class="loading loading-spinner loading-sm"></span>
						{:else}
							<Download class="h-5 w-5" aria-hidden="true" />
						{/if}
					</button>
				</div>
			{/each}
		</div>
	{:else}
		<div class="rounded-box bg-base-200 p-3">
			{#each tracks as track (track.spotify_id)}
				<div class="flex items-center gap-3 rounded-lg p-3 transition-colors hover:bg-base-300">
					<a
						href={track.spotify_url ?? `https://open.spotify.com/track/${track.spotify_id}`}
						target="_blank"
						rel="noreferrer"
						class="flex min-w-0 flex-1 items-center gap-3"
					>
						{#if track.album_image_url}
							<img src={track.album_image_url} alt="" class="size-12 rounded" />
						{:else}<div class="size-12 rounded bg-base-300"></div>{/if}
						<div class="min-w-0">
							<div class="truncate font-medium">{track.title}</div>
							<div class="truncate text-xs text-base-content/60">
								{track.artist} · {track.album}
							</div>
						</div>
					</a>
					<button
						class="btn btn-ghost btn-xs btn-circle"
						onclick={() => request(track)}
						disabled={download.isPending || requested.has(track.spotify_id)}
						aria-label="Request this track"
						title="Request this track"
					>
						{#if requested.has(track.spotify_id)}✓{:else}<Download class="h-3.5 w-3.5" />{/if}
					</button>
				</div>
			{/each}
		</div>
	{/if}
</section>
