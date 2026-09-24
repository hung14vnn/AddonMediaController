<script lang="ts">
	import { getAllSongs, getRandomSongs, getSongsByGenre } from '../api';
	import ErrorState from '../components/ErrorState.svelte';
	import Icon from '../components/Icon.svelte';
	import Sentinel from '../components/Sentinel.svelte';
	import TrackList from '../components/TrackList.svelte';
	import { getPlayer } from '../player.svelte';
	import type { Song } from '../types';

	const PAGE = 100;
	let { genre }: { genre?: string } = $props();
	const player = getPlayer();

	let songs = $state<Song[]>([]);
	let done = $state(false);
	let loading = $state(false);
	let error = $state<unknown>(null);

	async function more() {
		if (loading || done) return;
		loading = true;
		try {
			const page = genre ? await getSongsByGenre(genre, PAGE, songs.length) : await getAllSongs(songs.length, PAGE);
			songs.push(...page);
			if (page.length < PAGE) done = true;
		} catch (e) {
			error = e;
			done = true;
		} finally {
			loading = false;
		}
	}

	async function shuffle() {
		const pool = genre ? songs : await getRandomSongs(200);
		player.playList(pool, 0, { shuffle: true });
	}

	more();
</script>

<div class="page">
	{#if !genre}<h1 class="page-title">Songs</h1>{/if}
	{#if error && !songs.length}
		<ErrorState {error} />
	{:else if done && !songs.length}
		<div class="empty-state"><h3>No Songs</h3></div>
	{:else}
		<div class="pad actions bar">
			<button class="btn" disabled={!songs.length} onclick={() => player.playList(songs)}><Icon name="play" size={16} />Play</button>
			<button class="btn" disabled={!songs.length} onclick={shuffle}><Icon name="shuffle" size={16} />Shuffle</button>
		</div>
		<div class="pad"><TrackList {songs} /></div>
		{#if !done}<Sentinel onvisible={more} {loading} />{/if}
	{/if}
</div>

<style>
	.bar {
		margin-bottom: 16px;
	}
</style>
