<script lang="ts">
	// Paged album grid used by Albums, Recently Added and Genre pages.
	import { untrack } from 'svelte';
	import { getAlbumList } from '../api';
	import AlbumCard from '../components/AlbumCard.svelte';
	import ErrorState from '../components/ErrorState.svelte';
	import Sentinel from '../components/Sentinel.svelte';
	import type { Album, AlbumListType } from '../types';

	const PAGE = 60;

	let {
		title,
		initialType = 'alphabeticalByName',
		genre,
		sortable = false,
		limit
	}: { title: string; initialType?: AlbumListType; genre?: string; sortable?: boolean; limit?: number } = $props();

	let type = $state<AlbumListType>(untrack(() => initialType));
	let albums = $state<Album[]>([]);
	let done = $state(false);
	let loading = $state(false);
	let error = $state<unknown>(null);
	let generation = 0;

	const sorts: { value: AlbumListType; label: string }[] = [
		{ value: 'alphabeticalByName', label: 'Title' },
		{ value: 'alphabeticalByArtist', label: 'Artist' },
		{ value: 'newest', label: 'Recently Added' },
		{ value: 'recent', label: 'Recently Played' },
		{ value: 'frequent', label: 'Most Played' }
	];

	async function more() {
		if (loading || done) return;
		loading = true;
		const gen = generation;
		try {
			const extra = genre ? { genre } : {};
			const page = await getAlbumList(genre ? 'byGenre' : type, PAGE, albums.length, extra);
			if (gen !== generation) return;
			albums.push(...page);
			if (page.length < PAGE || (limit && albums.length >= limit)) done = true;
		} catch (e) {
			error = e;
			done = true;
		} finally {
			if (gen === generation) loading = false;
		}
	}

	$effect(() => {
		void type;
		void genre;
		generation++;
		albums = [];
		done = false;
		loading = false;
		error = null;
		untrack(more);
	});
</script>

<div class="page">
	<div class="head">
		<h1 class="page-title">{title}</h1>
		{#if sortable}
			<label class="sort">
				<span class="muted">Sort by</span>
				<select bind:value={type}>
					{#each sorts as s}<option value={s.value}>{s.label}</option>{/each}
				</select>
			</label>
		{/if}
	</div>
	{#if error && !albums.length}
		<ErrorState {error} />
	{:else if done && !albums.length}
		<div class="empty-state"><h3>No Albums</h3></div>
	{:else}
		<div class="grid">
			{#each albums as album (album.id)}<AlbumCard {album} />{/each}
		</div>
		{#if !done}<Sentinel onvisible={more} {loading} />{/if}
	{/if}
</div>

<style>
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding-right: var(--gutter);
	}
	.sort {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13px;
		margin-bottom: 20px;
	}
	select {
		font: inherit;
		font-size: 13px;
		color: var(--text);
		background: var(--fill);
		border: 0;
		border-radius: 7px;
		padding: 5px 8px;
	}
</style>
