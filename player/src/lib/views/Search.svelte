<script lang="ts">
	import { getGenres, search, type SearchSource } from '../api';
	import AlbumCard from '../components/AlbumCard.svelte';
	import ArtistCard from '../components/ArtistCard.svelte';
	import GenreTiles from '../components/GenreTiles.svelte';
	import Icon from '../components/Icon.svelte';
	import PlaylistCard from '../components/PlaylistCard.svelte';
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
	let shownSource: SearchSource | undefined;

	let field: HTMLInputElement | undefined = $state();

	const SOURCE_KEY = 'search:source';
	const sources: { id: SearchSource; label: string }[] = [
		{ id: 'spotify', label: 'Spotify' },
		{ id: 'ytmusic', label: 'YouTube Music' }
	];
	let source = $state<SearchSource>(savedSource());

	function savedSource(): SearchSource {
		try {
			return localStorage.getItem(SOURCE_KEY) === 'ytmusic' ? 'ytmusic' : 'spotify';
		} catch {
			return 'spotify';
		}
	}

	function pickSource(next: SearchSource) {
		source = next;
		try {
			localStorage.setItem(SOURCE_KEY, next);
		} catch {
			// private mode: the choice just lasts for this visit
		}
	}

	// Keep the field in sync when the query arrives from the sidebar search box,
	// but never clobber what the user is typing while the debounce is pending.
	$effect(() => {
		const q = query;
		if (document.activeElement !== field) input = q;
	});

	$effect(() => {
		const q = query.trim();
		const from = source;
		if (!q) {
			results = null;
			return;
		}
		const mine = ++seq;
		loading = true;
		// Keep showing old results while typing, but not another catalog's.
		if (from !== shownSource) results = null;
		shownSource = from;
		search(q, { artist: 12, album: 20, song: 10, playlist: 10 }, 0, false, from)
			.then((r) => mine === seq && (results = r))
			.catch(() => mine === seq && (results = { artists: [], albums: [], songs: [], playlists: [] }))
			.finally(() => mine === seq && (loading = false));
	});

	function onInput() {
		clearTimeout(timer);
		timer = setTimeout(() => router.go(`/search?q=${encodeURIComponent(input)}`, true), 300);
	}

	const empty = $derived(results && !results.artists.length && !results.albums.length && !results.songs.length && !results.playlists?.length);
</script>

<div class="page">
	<div class="top">
		<h1 class="page-title">Search</h1>
		<label class="field">
			<Icon name="search" size={18} />
			<input bind:this={field} type="search" placeholder="Artists, Songs, Albums, Playlists…" bind:value={input} oninput={onInput} autocapitalize="none" autocomplete="off" />
		</label>
		<div class="seg" role="tablist" aria-label="Search source">
			{#each sources as s (s.id)}
				<button role="tab" aria-selected={source === s.id} class:on={source === s.id} onclick={() => pickSource(s.id)}>{s.label}</button>
			{/each}
		</div>
	</div>

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
		{#if results.playlists?.length}
			<Shelf title="Playlists">
				{#each results.playlists as playlist (playlist.id)}<PlaylistCard {playlist} />{/each}
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
		margin: 0 var(--gutter) 12px;
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
	.seg {
		display: grid;
		grid-template-columns: 1fr 1fr;
		margin: 0 var(--gutter) 12px;
		padding: 2px;
		border-radius: 999px;
		background: var(--fill);
	}
	.seg button {
		height: 32px;
		padding: 0 16px;
		border-radius: 999px;
		font-size: 14px;
		font-weight: 500;
		white-space: nowrap;
		color: var(--text-2);
	}
	.seg button.on {
		color: var(--text);
		background: var(--bg-elevated);
		box-shadow: 0 1px 4px rgb(0 0 0 / 0.12);
	}
	.songs {
		margin-bottom: 30px;
	}
	@media (min-width: 900px) {
		/* Title on the left, source switch on the right; the sidebar has its
		   own search box on desktop. */
		.top {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 16px;
			margin-bottom: 20px;
		}
		.top .page-title {
			margin-bottom: 0;
		}
		.field {
			display: none;
		}
		.seg {
			margin: 0 var(--gutter) 0 0;
			border-radius: 9px;
		}
		.seg button {
			height: 28px;
			border-radius: 7px;
			font-size: 13px;
		}
	}
</style>
