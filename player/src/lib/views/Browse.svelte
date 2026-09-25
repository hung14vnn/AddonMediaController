<script lang="ts">
	import { getAlbumList, getGenres, optional, getTrendingSongs, getRandomRadioMix, getTrendingPlaylists } from '../api';
	import PlaylistCard from '../components/PlaylistCard.svelte';
	import AlbumCard from '../components/AlbumCard.svelte';
	import ErrorState from '../components/ErrorState.svelte';
	import GenreTiles from '../components/GenreTiles.svelte';
	import Shelf from '../components/Shelf.svelte';
	import TrackList from '../components/TrackList.svelte';
	import Icon from '../components/Icon.svelte';
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
	const trending = optional(getTrendingSongs(10, region));
	const radioMix = optional(getRandomRadioMix(15));
	const trendingPlaylists = optional(getTrendingPlaylists(region));
</script>

{#snippet songs(title: string, list: Song[])}
	{#if list.length}
		<section class="picks">
			<div class="picks-head">
				<h2 class="section-title">{title}</h2>
				<button class="btn secondary" onclick={() => player.playList(list)}><Icon name="play" size={14} />Play</button>
			</div>
			<div class="pad picks-list">
				<TrackList songs={list} showAlbum={false} />
			</div>
		</section>
	{/if}
{/snippet}

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
		{#await trending then list}{@render songs('Trending Songs', list)}{/await}
		{#await radioMix then list}{@render songs('Radio Mix', list)}{/await}
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
	.picks {
		margin-bottom: 30px;
	}
	.picks-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding-right: var(--gutter);
	}
	.picks-head .btn {
		min-width: 0;
		height: 28px;
		padding: 0 12px;
		font-size: 13px;
	}
	/* two columns of rows on wide screens, like Apple Music's song shelves */
	@media (min-width: 1100px) {
		.picks-list :global(.tracks) {
			display: grid;
			grid-template-columns: 1fr 1fr;
			column-gap: 24px;
		}
	}
</style>
