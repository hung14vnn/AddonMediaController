<script lang="ts">
	import { getAlbumList, getGenres, optional, getRandomRadioMix, getTrendingPlaylists } from '../api';
	import PlaylistCard from '../components/PlaylistCard.svelte';
	import AlbumCard from '../components/AlbumCard.svelte';
	import ErrorState from '../components/ErrorState.svelte';
	import GenreTiles from '../components/GenreTiles.svelte';
	import Shelf from '../components/Shelf.svelte';
	import { getPlayer } from '../player.svelte';
	import type { Song } from '../types';

	const player = getPlayer();

	function load() {
		return Promise.all([
			getAlbumList('newest', 20),
			optional(getAlbumList('frequent', 20)),
			optional(getAlbumList('random', 20)),
			optional(getGenres())
		]).then(([newest, frequent, random, genres]) => ({ newest, frequent, random, genres }));
	}
	let data = $state(load());

	const region = /-([A-Z]{2}) /.exec(navigator.language)?.[1];
	const radioMix = optional(getRandomRadioMix(15));
	const trendingPlaylists = optional(getTrendingPlaylists(region));
</script>



<div class="page">
	<h1 class="page-title">Browse</h1>
	{#await data}
		<div class="spinner"></div>
	{:then d}
		{#if d.newest.length}
			<Shelf title="New Releases" seeAll="#/recent" size="lg">
				{#each d.newest as album (album.id)}<AlbumCard {album} />{/each}
			</Shelf>
		{/if}
		{#await trendingPlaylists then list}
			{#if list.length}
				<Shelf title="Trending Playlists">
					{#each list as playlist (playlist.id)}<PlaylistCard {playlist} />{/each}
				</Shelf>
			{/if}
		{/await}
		{#await radioMix then list}
			{#if list.length}
				<Shelf title="Radio Mix">
					{#each list as playlist (playlist.id)}<PlaylistCard {playlist} />{/each}
				</Shelf>
			{/if}
		{/await}
		{#if d.frequent.length}
			<Shelf title="Most Played">
				{#each d.frequent as album (album.id)}<AlbumCard {album} />{/each}
			</Shelf>
		{/if}
		{#if d.genres.length}
			<h2 class="section-title"><a href="#/genres">Genres</a></h2>
			<GenreTiles genres={d.genres.slice(0, 12)} />
		{/if}
		{#if d.random.length}
			<div style="height: 30px"></div>
			<Shelf title="Something Different" seeAll="#/albums">
				{#each d.random as album (album.id)}<AlbumCard {album} />{/each}
			</Shelf>
		{/if}
	{:catch error}
		<ErrorState {error} retry={() => (data = load())} />
	{/await}
</div>

<style>
</style>
