<script lang="ts">
	import { getGenres, search } from '../api';
	import AlbumCard from '../components/AlbumCard.svelte';
	import ArtistCard from '../components/ArtistCard.svelte';
	import GenreTiles from '../components/GenreTiles.svelte';
	import Icon from '../components/Icon.svelte';
	import Shelf from '../components/Shelf.svelte';
	import TrackList from '../components/TrackList.svelte';
	import { router } from '../router.svelte';

	let { query }: { query: string } = $props();

	let input = $state('');
	let results = $state<Awaited<ReturnType<typeof search>> | null>(null);
	let loading = $state(false);
	const genres = getGenres().catch(() => []);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let seq = 0;

	let field: HTMLInputElement | undefined = $state();

	// Keep the field in sync when the query arrives from the sidebar search box,
	// but never clobber what the user is typing while the debounce is pending.
	$effect(() => {
		const q = query;
		if (document.activeElement !== field) input = q;
	});

	$effect(() => {
		const q = query.trim();
		if (!q) {
			results = null;
			return;
		}
		const mine = ++seq;
		loading = true;
		search(q, { artist: 12, album: 20, song: 30 })
			.then((r) => mine === seq && (results = r))
			.catch(() => mine === seq && (results = { artists: [], albums: [], songs: [] }))
			.finally(() => mine === seq && (loading = false));
	});

	function onInput() {
		clearTimeout(timer);
		timer = setTimeout(() => router.go(`/search?q=${encodeURIComponent(input)}`, true), 250);
	}

	const empty = $derived(results && !results.artists.length && !results.albums.length && !results.songs.length);
</script>

<div class="page">
	<h1 class="page-title">Search</h1>
	<label class="field">
		<Icon name="search" size={18} />
		<input bind:this={field} type="search" placeholder="Artists, Songs, Albums…" bind:value={input} oninput={onInput} autocapitalize="none" autocomplete="off" />
	</label>

	{#if !query.trim()}
		{#await genres then list}
			{#if list.length}
				<h2 class="section-title">Browse Categories</h2>
				<GenreTiles genres={list.slice(0, 24)} />
			{/if}
		{/await}
	{:else if loading && !results}
		<div class="spinner"></div>
	{:else if empty}
		<div class="empty-state">
			<h3>No Results</h3>
			<p>Try a new search.</p>
		</div>
	{:else if results}
		{#if results.songs.length}
			<h2 class="section-title">Songs</h2>
			<div class="pad songs"><TrackList songs={results.songs} /></div>
		{/if}
		{#if results.artists.length}
			<Shelf title="Artists" size="artist">
				{#each results.artists as artist (artist.id)}<ArtistCard {artist} />{/each}
			</Shelf>
		{/if}
		{#if results.albums.length}
			<Shelf title="Albums">
				{#each results.albums as album (album.id)}<AlbumCard {album} />{/each}
			</Shelf>
		{/if}
	{/if}
</div>

<style>
	.field {
		display: flex;
		align-items: center;
		gap: 8px;
		height: 38px;
		margin: 0 var(--gutter) 24px;
		padding: 0 12px;
		border-radius: 10px;
		color: var(--text-2);
		background: var(--fill);
	}
	.field input {
		flex: 1;
		min-width: 0;
		border: 0;
		outline: none;
		background: none;
		font: inherit;
		font-size: 16px;
		color: var(--text);
	}
	.songs {
		margin-bottom: 30px;
	}
	/* The sidebar has its own search box on desktop. */
	@media (min-width: 900px) {
		.field {
			display: none;
		}
	}
</style>
