<script lang="ts">
	import { API } from '$lib/constants';
	import { api } from '$lib/api/client';
	import type { SpotifyTrackResult } from '$lib/types';
	import SpotifyTrackList from './SpotifyTrackList.svelte';
	import Toast from './Toast.svelte';

	type SpotifyTracksPage = {
		tracks: SpotifyTrackResult[];
		next_offset: number | null;
		has_more: boolean;
	};

	let { artistId, artistName }: { artistId: string; artistName: string } = $props();
	let tracks = $state<SpotifyTrackResult[]>([]);
	let nextOffset = $state<number | null>(null);
	let hasMore = $state(false);
	let loadingInitial = $state(true);
	let loadingMore = $state(false);
	let showToast = $state(false);
	let toastMessage = $state('');
	let toastType = $state<'success' | 'error' | 'info'>('info');

	function showStatus(message: string, type: 'success' | 'error' | 'info'): void {
		toastMessage = message;
		toastType = type;
		showToast = true;
	}

	async function fetchPage(offset: number): Promise<SpotifyTracksPage> {
		return api.global.get<SpotifyTracksPage>(
			`${API.artist.spotifyTracks(artistId, artistName)}&offset=${offset}`
		);
	}

	async function loadInitial(): Promise<void> {
		loadingInitial = true;
		try {
			const page = await fetchPage(0);
			tracks = page.tracks;
			nextOffset = page.next_offset;
			hasMore = page.has_more;
		} catch {
			tracks = [];
			nextOffset = null;
			hasMore = false;
			showStatus("Couldn't load Spotify tracks.", 'error');
		} finally {
			loadingInitial = false;
		}
	}

	async function loadMore(): Promise<void> {
		if (loadingMore || nextOffset === null) return;
		loadingMore = true;
		try {
			const page = await fetchPage(nextOffset);
			tracks = [...new Map([...tracks, ...page.tracks].map((track) => [track.spotify_id, track])).values()];
			nextOffset = page.next_offset;
			hasMore = page.has_more;
			showStatus(
				page.tracks.length ? `Loaded ${page.tracks.length} more Spotify tracks.` : 'Spotify has no more matching tracks.',
				'info'
			);
		} catch {
			showStatus("Couldn't load more Spotify tracks.", 'error');
		} finally {
			loadingMore = false;
		}
	}

	$effect(() => {
		artistId;
		artistName;
		void loadInitial();
	});
</script>

{#if loadingInitial}
	<div class="mt-6 flex items-center gap-2 text-sm text-base-content/60">
		<span class="loading loading-spinner loading-xs"></span> Loading Spotify tracks…
	</div>
{:else}
	<SpotifyTrackList {tracks} />
{/if}

{#if hasMore}
	<div class="mt-3 text-center">
		<button class="btn btn-sm btn-outline" disabled={loadingMore} onclick={loadMore}>
			{#if loadingMore}<span class="loading loading-spinner loading-xs"></span>{/if}
			{loadingMore ? 'Loading…' : 'Load more'}
		</button>
	</div>
{/if}

<Toast bind:show={showToast} message={toastMessage} type={toastType} />
