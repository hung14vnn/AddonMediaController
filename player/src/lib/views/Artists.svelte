<script lang="ts">
	import { getArtists } from '../api';
	import ArtistCard from '../components/ArtistCard.svelte';
	import ErrorState from '../components/ErrorState.svelte';
	import Icon from '../components/Icon.svelte';
	import { router } from '../router.svelte';
	import type { Artist } from '../types';

	let data = $state(getArtists());
	// Render progressively; big libraries have thousands of artists.
	let shown = $state(120);
	let query = $state('');
	let sort = $state<'name' | 'albums'>('name');

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

	function filtered(list: Artist[]) {
		return list
			.filter((artist) => artist.name.toLowerCase().includes(query.toLowerCase()))
			.sort((a, b) => sort === 'albums' ? (b.albumCount ?? 0) - (a.albumCount ?? 0) : a.name.localeCompare(b.name));
	}
</script>

<div class="page">
	<div class="head">
		<button class="back" onclick={() => router.go('/library')}><Icon name="chevronLeft" size={18} />Library</button>
		<label class="sort" aria-label="Sort artists"><span>Sort</span><select bind:value={sort}><option value="name">Name</option><option value="albums">Albums</option></select></label>
	</div>
	<h1 class="page-title">Artists</h1>
	<div class="tools">
		<label class="search"><Icon name="search" size={16} /><input type="search" placeholder="Search artists…" bind:value={query} /></label>
	</div>
	{#await data}
		<div class="spinner"></div>
	{:then list}
		{#if !list.length}
			<div class="empty-state"><h3>No Artists</h3></div>
		{:else}
			{@const visible = filtered(list).slice(0, shown)}
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
	.head { display: flex; align-items: center; gap: 12px; padding: 0 var(--gutter); margin-bottom: 8px; }
	.head .page-title { flex: 1; }
	.back { display: inline-flex; align-items: center; gap: 2px; color: var(--accent); font-size: 14px; white-space: nowrap; }
	.tools { display: flex; gap: 10px; align-items: center; margin: 0 var(--gutter) 16px; }
	.search { flex: 1; display: flex; align-items: center; gap: 8px; padding: 8px 10px; color: var(--text-2); background: var(--fill); border-radius: 9px; }
	.search input { min-width: 0; width: 100%; border: 0; outline: 0; background: none; color: var(--text); font: inherit; }
	.sort { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-2); }
	select { color: var(--text); background: var(--fill); border: 0; border-radius: 7px; padding: 7px 6px; font: inherit; }
	.sort { position: relative; color: var(--accent); margin-left: auto; }
	.sort select { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; }
	@media (max-width: 699px) {
		.tools { margin: 0 10px 14px; }
		.letter { margin: 12px 10px 8px; font-size: 13px; }
	}
</style>
