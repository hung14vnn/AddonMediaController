<script lang="ts">
	import { Download, Check } from 'lucide-svelte';
	import type { SpotifyTrackResult } from '$lib/types';
	import { requestSpotifyTrack } from '$lib/queries/downloads/DownloadMutations.svelte';
	import StreamButton from '$lib/components/discover/StreamButton.svelte';

	let {
		tracks,
		title = 'Spotify tracks',
		variant = 'list'
	}: { tracks: SpotifyTrackResult[]; title?: string; variant?: 'list' | 'grid' } = $props();
	const download = requestSpotifyTrack();
	let requested = $state<Set<string>>(new Set());
	let pending = $state<Set<string>>(new Set());

	async function request(track: SpotifyTrackResult) {
		if (pending.has(track.spotify_id) || requested.has(track.spotify_id)) return;
		pending = new Set([...pending, track.spotify_id]);
		try {
			await download.mutateAsync(track.spotify_id);
			requested = new Set([...requested, track.spotify_id]);
		} catch {
			// The mutation owns the error toast; keep this handler from producing an
			// unhandled rejection while allowing the row to be retried.
		} finally {
			pending = new Set([...pending].filter((id) => id !== track.spotify_id));
		}
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
					class="group relative overflow-hidden rounded-box bg-base-200 transition-transform hover:-translate-y-0.5 hover:bg-base-300 flex flex-col"
				>
					<div class="relative w-full aspect-square">
						<a
							href={track.spotify_url ?? `https://open.spotify.com/track/${track.spotify_id}`}
							target="_blank"
							rel="noreferrer"
							class="absolute inset-0 z-0"
						>
							{#if track.album_image_url}
								<img src={track.album_image_url} alt="" class="h-full w-full object-cover" />
							{:else}<div class="h-full w-full bg-base-300"></div>{/if}
						</a>
						
						<div
							class="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-black/0 transition-colors duration-200 group-hover:bg-black/65 group-focus-within:bg-black/65 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 focus-within:opacity-100"
						>
							<div class="pointer-events-auto flex items-center justify-center">
								<StreamButton
									artist={track.artist}
									title={track.title}
									album={track.album}
									coverUrl={track.album_image_url}
									size="md"
								/>
							</div>
						</div>
					</div>
					<a
						href={track.spotify_url ?? `https://open.spotify.com/track/${track.spotify_id}`}
						target="_blank"
						rel="noreferrer"
						class="flex-1 block z-0"
					>
						<div class="card-body p-3 h-full pb-10">
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
						class="btn btn-square btn-md absolute bottom-2 right-2 z-20 border-none bg-accent text-accent-content opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 focus-visible:opacity-100 shadow-lg transition-opacity duration-200"
						onclick={() => request(track)}
						disabled={pending.has(track.spotify_id) || requested.has(track.spotify_id)}
						aria-label="Request this track"
						aria-busy={pending.has(track.spotify_id)}
						title="Request this track"
					>
						{#if pending.has(track.spotify_id)}
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
				<div class="flex items-center gap-3 rounded-lg p-3 transition-colors hover:bg-base-300 group">
					<div class="relative flex-none size-12 rounded overflow-hidden">
						{#if track.album_image_url}
							<img src={track.album_image_url} alt="" class="w-full h-full object-cover" />
						{:else}
							<div class="w-full h-full bg-base-300"></div>
						{/if}
					</div>
					<a
						href={track.spotify_url ?? `https://open.spotify.com/track/${track.spotify_id}`}
						target="_blank"
						rel="noreferrer"
						class="flex min-w-0 flex-1 items-center gap-3"
					>
						<div class="min-w-0">
							<div class="truncate font-medium">{track.title}</div>
							<div class="truncate text-xs text-base-content/60 group-hover:underline">
								{track.artist} · {track.album}
							</div>
						</div>
					</a>
					<div class="flex items-center gap-0.5">
						<StreamButton
							artist={track.artist}
							title={track.title}
							album={track.album}
							coverUrl={track.album_image_url}
							size="xs"
							wrapperClass="contents"
						/>
						<button
							class="btn btn-ghost btn-circle btn-xs h-7 w-7 min-h-0 min-w-0 shrink-0 -ml-1"
							onclick={() => request(track)}
							disabled={pending.has(track.spotify_id) || requested.has(track.spotify_id)}
							aria-label="Request this track"
							aria-busy={pending.has(track.spotify_id)}
							title="Request this track"
						>
							{#if pending.has(track.spotify_id)}
								<span class="loading loading-spinner loading-xs"></span>
							{:else if requested.has(track.spotify_id)}
								<Check class="h-4 w-4 text-success" />
							{:else}
								<Download class="h-4 w-4" />
							{/if}
						</button>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</section>
