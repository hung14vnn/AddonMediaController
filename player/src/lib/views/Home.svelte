<script lang="ts">
	import {
		allNow,
		cachedNow,
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
	import type { Album, Song } from "../types";
	import type { Maybe } from "../api";

	const player = getPlayer();

	// Library shelves paint from the on-device copy without waiting on the network.
	// frequent shares Browse's cache key; random gets its own so the two tabs differ.
	// Revisited in the same session, everything below is a plain value, so the page paints
	// its last state in the same frame and only re-renders where the server differs.
	type Shelves = { newest: Album[]; frequent: Album[]; random: Album[] };
	function load(): Maybe<Shelves> {
		const shelves = allNow([
			cachedNow("home:newest", () => getAlbumList("newest", 20), {
				fresh: 0,
				// Patch the resolved value in place: wrapping it in a promise would re-show the spinner.
				refresh: (newest) => {
					const current = data;
					if (current instanceof Promise) void current.then((d) => (data = { ...d, newest }));
					else data = { ...current, newest };
				},
			}),
			optional(cachedNow("browse:frequent", () => getAlbumList("frequent", 20))),
			optional(cachedNow("home:random", () => getAlbumList("random", 20))),
		]);
		const assemble = ([newest, frequent, random]: [Album[], Album[], Album[]]) => ({ newest, frequent, random });
		return shelves instanceof Promise ? shelves.then(assemble) : assemble(shelves);
	}

	let data = $state(load());

	// Recently played and favorites change often: shown from the cached copy at once and
	// swapped when the server differs. Picks are meant to be random every visit. None of
	// these hold back the shelves above.
	let recent = $state(
		optional(
			cachedNow("home:recent", () => getAlbumList("recent", 20), {
				fresh: 0,
				refresh: (list) => (recent = list),
			}),
		),
	);
	let starred = $state(
		optional(
			cachedNow("home:starred", () => getAlbumList("starred", 20), {
				fresh: 0,
				refresh: (list) => (starred = list),
			}),
		),
	);
	// Last visit's picks paint at once (so nothing below shifts when scroll is restored on
	// back); a fresh random set swaps into the same slot once it arrives.
	let picks = $state(
		optional(
			cachedNow("home:picks", () => getRandomSongs(12), {
				fresh: 0,
				refresh: (list) => (picks = list),
			}),
		),
	);

	// Charts come from YouTube Music / Spotify and can be slow on a cold cache, so
	// they load on their own and never hold back (or break) the library shelves.
	const region = /-([A-Z]{2})/.exec(navigator.language)?.[1];
	let trending = $state(
		optional(
			cachedNow(`home:trending:12:${region ?? ""}`, () => getTrendingSongs(12, region), {
				refresh: (list) => (trending = list),
			}),
		),
	);
	let hits = $state(
		optional(cachedNow("home:hits:12", () => getTodaysHits(12), { refresh: (list) => (hits = list) })),
	);

	function mobilePages(list: Song[]): Song[][] {
		const pages: Song[][] = [];
		for (let i = 0; i < list.length; i += 4) pages.push(list.slice(i, i + 4));
		return pages;
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
			<div class="pad picks-list desktop-picks">
				<TrackList songs={list} showAlbum={false} />
			</div>
			<div class="pad mobile-picks">
				<div class="mobile-picks-scroller">
					{#each mobilePages(list) as page, i}
						<div class="mobile-picks-page" class:last={i === mobilePages(list).length - 1}>
							<TrackList songs={page} showAlbum={false} />
						</div>
					{/each}
				</div>
			</div>
		</section>
	{/if}
{/snippet}

<div class="page">
	<div class="head">
		<h1 class="page-title">Home</h1>
		<div class="head-actions">
			<ProfileButton />
		</div>
	</div>
	<p class="greet muted"></p>

	{#await data}
		<div class="spinner"></div>
	{:then d}
		{#if !d.newest.length}
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
			{#await recent then list}
				{#if list.length}
					<Shelf title="Recently Played" size="lg">
						{#each list as album (album.id)}<AlbumCard {album} />{/each}
					</Shelf>
				{/if}
			{/await}
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
			{#await picks then list}{@render songs("Top Picks for You", list)}{/await}
			{#if d.frequent.length}
				<Shelf title="Heavy Rotation">
					{#each d.frequent as album (album.id)}<AlbumCard
							{album}
						/>{/each}
				</Shelf>
			{/if}
			{#await starred then list}
				{#if list.length}
					<Shelf title="Favorite Albums" seeAll="#/loved">
						{#each list as album (album.id)}<AlbumCard {album} />{/each}
					</Shelf>
				{/if}
			{/await}
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
	.mobile-picks {
		display: none;
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
		.desktop-picks {
			display: none;
		}

		.mobile-picks {
			display: block;
			overflow: hidden;
		}

		.mobile-picks-scroller {
			display: flex;
			gap: 12px;
			overflow-x: auto;
			scroll-snap-type: x mandatory;
			scrollbar-width: none;
			overscroll-behavior-x: contain;
		}

		.mobile-picks-scroller::-webkit-scrollbar {
			display: none;
		}

		.mobile-picks-page {
			/* Leave a small preview of the next four-song column visible. */
			flex: 0 0 calc(100% - 28px);
			scroll-snap-align: start;
		}

		.mobile-picks-page.last {
			flex-basis: 100%;
		}
	}
</style>
