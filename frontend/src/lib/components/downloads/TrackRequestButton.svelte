<script lang="ts">
	import { Download } from 'lucide-svelte';

	import {
		requestSpotifyTrack,
		requestTrack
	} from '$lib/queries/downloads/DownloadMutations.svelte';

	const SPOTIFY_TRACK_PREFIX = 'spotify:track:';

	// orphan-track case (album not in library) is resolved by the backend
	interface Props {
		recordingMbid: string;
		trackTitle: string;
		artistName: string;
		albumMbid: string;
		albumTitle?: string | null;
		durationSeconds?: number | null;
		artistMbid?: string | null;
		releaseMbid?: string | null;
	}
	let {
		recordingMbid,
		trackTitle,
		artistName,
		albumMbid,
		albumTitle = null,
		durationSeconds = null,
		artistMbid = null,
		releaseMbid = null
	}: Props = $props();

	const request = requestTrack();
	const spotifyRequest = requestSpotifyTrack();
	let requested = $state(false);

	function handleClick() {
		if (recordingMbid.startsWith(SPOTIFY_TRACK_PREFIX)) {
			spotifyRequest.mutate(recordingMbid.slice(SPOTIFY_TRACK_PREFIX.length), {
				onSuccess: () => (requested = true)
			});
			return;
		}

		request.mutate(
			{
				recording_mbid: recordingMbid,
				artist_name: artistName,
				track_title: trackTitle,
				album_title: albumTitle,
				duration_seconds: durationSeconds,
				release_group_mbid: albumMbid,
				artist_mbid: artistMbid,
				release_id: releaseMbid
			},
			{ onSuccess: () => (requested = true) }
		);
	}
</script>

<button
	class="btn btn-ghost btn-xs btn-circle"
	onclick={handleClick}
	disabled={request.isPending || spotifyRequest.isPending || requested}
	aria-label="Request this track"
	title="Request this track"
>
	{#if request.isPending || spotifyRequest.isPending}
		<span class="loading loading-spinner loading-xs"></span>
	{:else}
		<Download class="h-3.5 w-3.5" aria-hidden="true" />
	{/if}
</button>
