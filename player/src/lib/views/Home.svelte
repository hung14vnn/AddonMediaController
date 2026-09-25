<script lang="ts">
	import {
		getAlbumList,
		getRandomSongs,
		getTodaysHits,
		getTrendingSongs,
		optional,
	} from "../api";
	import AlbumCard from "../components/AlbumCard.svelte";
	import ErrorState from "../components/ErrorState.svelte";
	import Icon from "../components/Icon.svelte";
	import ProfileButton from "../components/ProfileButton.svelte";
	import Shelf from "../components/Shelf.svelte";
	import TrackList from "../components/TrackList.svelte";
	import { getPlayer } from "../player.svelte";
	import type { Song } from "../types";

	const player = getPlayer();

	function load() {
		return Promise.all([
			optional(getAlbumList("recent", 20)),
			getAlbumList("newest", 20),
			optional(getAlbumList("frequent", 20)),
			optional(getAlbumList("random", 20)),
			optional(getAlbumList("starred", 20)),
			optional(getRandomSongs(12)),
		]).then(([recent, newest, frequent, random, starred, picks]) => ({
			recent,
			newest,
			frequent,
			random,
			starred,
			picks,
		}));
	}

	let data = $state(load());

	// Charts come from YouTube Music / Spotify and can be slow on a cold cache, so
	// they load on their own and never hold back (or break) the library shelves.
	const region = /-([A-Z]{2})/.exec(navigator.language)?.[1];
	const trending = optional(getTrendingSongs(10, region));
	const hits = optional(getTodaysHits(10));

	async function shuffleAll() {
		player.playList(await getRandomSongs(100), 0, { shuffle: true });
	}
</script>

{#snippet songs(title: string, list: Song[])}
	{#if list.length}
		<section class="picks">
			<div class="picks-head">
				<h2 class="section-title">{title}</h2>
				<button
					class="btn secondary"
					onclick={() => player.playList(list)}
					><Icon name="play" size={14} />Play</button
				>
			</div>
			<div class="pad picks-list">
				<TrackList songs={list} showAlbum={false} />
			</div>
		</section>
	{/if}
{/snippet}

<div class="page">
	<div class="head">
		<h1 class="page-title">Home</h1>
		<div class="head-actions">
			<button class="btn secondary" onclick={shuffleAll}
				><Icon name="shuffle" size={16} />Shuffle All</button
			>
			<ProfileButton />
		</div>
	</div>
	<p class="greet muted"></p>

	{#await data}
		<div class="spinner"></div>
	{:then d}
		{#if !d.recent.length && !d.newest.length}
			<div class="empty-state">
				<Icon name="note" size={48} />
				<h3>Your library is empty</h3>
				<p>Add music on the server and it will show up here.</p>
			</div>
			{#await hits then list}{@render songs("Today's Hits", list)}{/await}
			{#await trending then list}{@render songs(
					"Trending Songs",
					list,
				)}{/await}
		{:else}
			{#if d.recent.length}
				<Shelf title="Recently Played" size="lg">
					{#each d.recent as album (album.id)}<AlbumCard
							{album}
						/>{/each}
				</Shelf>
			{/if}
			{#await trending then list}{@render songs(
					"Trending Songs",
					list,
				)}{/await}

			{#if d.newest.length}
				<Shelf title="Recently Added" seeAll="#/recent">
					{#each d.newest as album (album.id)}<AlbumCard
							{album}
						/>{/each}
				</Shelf>
			{/if}
			{#await hits then list}{@render songs("Today's Hits", list)}{/await}
			{@render songs("Top Picks for You", d.picks)}
			{#if d.frequent.length}
				<Shelf title="Heavy Rotation">
					{#each d.frequent as album (album.id)}<AlbumCard
							{album}
						/>{/each}
				</Shelf>
			{/if}
			{#if d.starred.length}
				<Shelf title="Favorite Albums" seeAll="#/loved">
					{#each d.starred as album (album.id)}<AlbumCard
							{album}
						/>{/each}
				</Shelf>
			{/if}
			{#if d.random.length}
				<Shelf title="Rediscover" seeAll="#/albums">
					{#each d.random as album (album.id)}<AlbumCard
							{album}
						/>{/each}
				</Shelf>
			{/if}
		{/if}
	{:catch error}
		<ErrorState {error} retry={() => (data = load())} />
	{/await}
</div>

<style>
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding-right: var(--gutter);
	}
	.head .page-title {
		margin-bottom: 0;
	}
	.head-actions {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.greet {
		margin: 2px var(--gutter) 22px;
		font-size: 15px;
	}
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
	@media (max-width: 699px) {
		.head .btn {
			min-width: 0;
			padding: 0 12px;
		}
	}
</style>
