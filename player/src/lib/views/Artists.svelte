<script lang="ts">
	import { getArtists } from '../api';
	import ArtistCard from '../components/ArtistCard.svelte';
	import ErrorState from '../components/ErrorState.svelte';
	import type { Artist } from '../types';

	let data = $state(getArtists());
	// Render progressively; big libraries have thousands of artists.
	let shown = $state(120);

	function sections(list: Artist[]) {
		const map = new Map<string, Artist[]>();
		for (const a of list) {
			const ch = a.name.trim().charAt(0).toUpperCase();
			const key = /[A-Z]/.test(ch) ? ch : '#';
			if (!map.has(key)) map.set(key, []);
			map.get(key)!.push(a);
		}
		return [...map.entries()];
	}
</script>

<div class="page">
	<h1 class="page-title">Artists</h1>
	{#await data}
		<div class="spinner"></div>
	{:then list}
		{#if !list.length}
			<div class="empty-state"><h3>No Artists</h3></div>
		{:else}
			{@const visible = list.slice(0, shown)}
			{#each sections(visible) as [letter, artists] (letter)}
				<h2 class="letter">{letter}</h2>
				<div class="grid artists">
					{#each artists as artist (artist.id)}<ArtistCard {artist} />{/each}
				</div>
			{/each}
			{#if shown < list.length}
				<div class="pad more"><button class="btn secondary" onclick={() => (shown += 240)}>Show More</button></div>
			{/if}
		{/if}
	{:catch error}
		<ErrorState {error} retry={() => (data = getArtists())} />
	{/await}
</div>

<style>
	.letter {
		margin: 22px var(--gutter) 12px;
		padding-bottom: 6px;
		font-size: 15px;
		font-weight: 700;
		color: var(--text-2);
		border-bottom: 0.5px solid var(--hairline);
	}
	.letter:first-of-type {
		margin-top: 0;
	}
	.more {
		margin-top: 28px;
	}
</style>
