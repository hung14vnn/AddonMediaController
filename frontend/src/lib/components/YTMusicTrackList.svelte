<script lang="ts">
	import { Download, Check } from 'lucide-svelte';
	import type { YTMusicTrackResult } from '$lib/types';
	import { requestYouTubeTrack } from '$lib/queries/downloads/DownloadMutations.svelte';
	import StreamButton from '$lib/components/discover/StreamButton.svelte';

	let {
		tracks,
		title = 'YouTube Music tracks',
		loading = false
	}: { tracks: YTMusicTrackResult[]; title?: string; loading?: boolean } = $props();
	const download = requestYouTubeTrack();
	let requested = $state<Set<string>>(new Set());
	let pending = $state<Set<string>>(new Set());

	async function request(track: YTMusicTrackResult) {
		if (pending.has(track.video_id) || requested.has(track.video_id)) return;
		pending = new Set([...pending, track.video_id]);
		try {
			await download.mutateAsync(track);
			requested = new Set([...requested, track.video_id]);
		} catch {
			// The mutation owns the error toast; keep the row retryable.
		} finally {
			pending = new Set([...pending].filter((id) => id !== track.video_id));
		}
	}
</script>

<section class="mt-6">
	<h2 class="text-xl font-bold mb-4">{title}</h2>
	{#if loading && tracks.length === 0}
		<div class="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
			{#each Array(6) as _, i (`yt-skeleton-${i}`)}
				<div class="skeleton skeleton-shimmer aspect-[3/4] rounded-box"></div>
			{/each}
		</div>
	{:else if tracks.length === 0}
		<div class="rounded-box bg-base-200 p-6 text-center text-sm text-base-content/60">
			No YouTube Music tracks found.
		</div>
	{:else}
		<div class="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
			{#each tracks as track (track.video_id)}
				<div
					class="group relative overflow-hidden rounded-box bg-base-200 transition-transform hover:-translate-y-0.5 hover:bg-base-300 flex flex-col"
				>
					<div class="relative w-full aspect-square">
						<a href={track.url} target="_blank" rel="noreferrer" class="absolute inset-0 z-0">
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
					<a href={track.url} target="_blank" rel="noreferrer" class="flex-1 block z-0">
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
						disabled={pending.has(track.video_id) || requested.has(track.video_id)}
						aria-label="Download this track with yt-dlp"
						aria-busy={pending.has(track.video_id)}
						title="Download this track"
					>
						{#if pending.has(track.video_id)}
							<span class="loading loading-spinner loading-sm"></span>
						{:else if requested.has(track.video_id)}
							<Check class="h-5 w-5" aria-hidden="true" />
						{:else}
							<Download class="h-5 w-5" aria-hidden="true" />
						{/if}
					</button>
				</div>
			{/each}
		</div>
	{/if}
</section>
