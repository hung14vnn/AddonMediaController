<script lang="ts">
	import { coverUrl, getAlbum, getArtist, getArtistInfo, getTopSongs } from '../api';
	import AlbumCard from '../components/AlbumCard.svelte';
	import ArtistCard from '../components/ArtistCard.svelte';
	import ErrorState from '../components/ErrorState.svelte';
	import Icon from '../components/Icon.svelte';
	import Shelf from '../components/Shelf.svelte';
	import TrackList from '../components/TrackList.svelte';
	import { stripHtml } from '../format';
	import { startStation } from '../menus';
	import { getPlayer } from '../player.svelte';
	import type { Album } from '../types';
	import { ui } from '../ui.svelte';

	let { id }: { id: string } = $props();
	const player = getPlayer();

	async function load(artistId: string) {
		const artist = await getArtist(artistId);
		const [info, top] = await Promise.all([getArtistInfo(artistId), getTopSongs(artist.name, 10)]);
		const albums = [...(artist.album ?? [])].sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
		const isSingle = (a: Album) =>
			a.releaseTypes?.some((t) => /single|ep/i.test(t)) ?? (a.songCount !== undefined && a.songCount <= 3);
		return {
			artist,
			info,
			top,
			latest: albums[0],
			albums: albums.filter((a) => !isSingle(a) && !a.isCompilation),
			singles: albums.filter(isSingle),
			compilations: albums.filter((a) => a.isCompilation && !isSingle(a))
		};
	}

	let data = $derived(load(id));
	let bioOpen = $state(false);
	let imageErrorCount = $state(0);

	$effect(() => {
		id;
		imageErrorCount = 0;
	});

	async function allSongs(albums: Album[]) {
		const full = await Promise.all(albums.map((a) => getAlbum(a.id)));
		return full.flatMap((a) => a.song ?? []);
	}
</script>

{#await data}
	<div class="spinner"></div>
{:then d}
	{@const candidates = [d.artist.artistImageUrl, coverUrl(d.artist.coverArt, 1200), d.info.largeImageUrl, d.info.mediumImageUrl].filter(Boolean) as string[]}
	{@const image = candidates[Math.min(imageErrorCount, candidates.length - 1)]}
	{@const bio = stripHtml(d.info.biography)}
	<div class="page artist-page">
		<header class="hero" class:has-image={!!image && imageErrorCount < candidates.length}>
			{#if image && imageErrorCount < candidates.length}<img src={image} alt="" decoding="async" onerror={() => imageErrorCount++} />{/if}
			<div class="hero-body">
				<h1>{d.artist.name}</h1>
				<div class="hero-actions">
					<button
						class="play"
						aria-label="Play {d.artist.name}"
						onclick={async () => player.playList(d.top.length ? d.top : await allSongs(d.albums.slice(0, 3)))}
					>
						<Icon name="play" size={24} />
					</button>
					<button
						class="pill"
						onclick={async () => player.playList(await allSongs([...d.albums, ...d.singles]), 0, { shuffle: true })}
					>
						<Icon name="shuffle" size={15} />Shuffle
					</button>
					{#if d.top[0]}
						<button class="pill" onclick={() => startStation(d.top[0])}>
							<Icon name="radio" size={15} />Station
						</button>
					{/if}
					<button
						class="pill icon"
						aria-label="Favorite"
						onclick={() => ui.toggleLove('artist', d.artist)}
					>
						<Icon name={ui.isLoved(d.artist) ? 'starFill' : 'star'} size={17} />
					</button>
				</div>
			</div>
		</header>

		<div class="top-row">
			{#if d.latest}
				<section class="latest">
					<h2 class="section-title flush">Latest Release</h2>
					<AlbumCard album={d.latest} showYear />
				</section>
			{/if}
			{#if d.top.length}
				<section class="top">
					<h2 class="section-title flush">Top Songs</h2>
					<TrackList songs={d.top.slice(0, 8)} showAlbum={false} onplay={(i) => player.playList(d.top, i)} />
				</section>
			{/if}
		</div>

		{#if d.albums.length}
			<Shelf title="Albums">
				{#each d.albums as album (album.id)}<AlbumCard {album} showYear />{/each}
			</Shelf>
		{/if}
		{#if d.singles.length}
			<Shelf title="Singles & EPs" size="sm">
				{#each d.singles as album (album.id)}<AlbumCard {album} showYear />{/each}
			</Shelf>
		{/if}
		{#if d.compilations.length}
			<Shelf title="Compilations">
				{#each d.compilations as album (album.id)}<AlbumCard {album} showYear />{/each}
			</Shelf>
		{/if}
		{#if d.info.similarArtist?.length}
			<Shelf title="Similar Artists" size="artist">
				{#each d.info.similarArtist.filter((a) => a.id) as artist (artist.id)}<ArtistCard {artist} />{/each}
			</Shelf>
		{/if}
		{#if bio}
			<section class="about pad">
				<h2 class="section-title flush">About {d.artist.name}</h2>
				<button class="bio" class:open={bioOpen} onclick={() => (bioOpen = !bioOpen)}>
					{bio}
				</button>
			</section>
		{/if}
	</div>
{:catch error}
	<ErrorState {error} retry={() => (data = load(id))} />
{/await}

<style>
	.artist-page {
		padding-top: 0;
	}
	.hero {
		position: relative;
		height: clamp(260px, 42vh, 460px);
		display: flex;
		align-items: flex-end;
		margin-bottom: 26px;
		overflow: hidden;
		background: linear-gradient(160deg, var(--fill-strong), var(--fill));
	}
	.hero img {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
		object-position: center 25%;
		animation: hero-settle 1.6s cubic-bezier(0.2, 0.8, 0.2, 1) both;
		/* Ép tạo compositor layer riêng để animation mượt mà không khựng GPU */
		will-change: transform, opacity;
	}
	@keyframes hero-settle {
		from {
			opacity: 0;
			transform: scale(1.12);
		}
		to {
			opacity: 1;
			transform: scale(1);
		}
	}
	.hero.has-image::after {
		content: '';
		position: absolute;
		inset: 0;
		background: linear-gradient(to top, rgba(0, 0, 0, 0.65), transparent 60%);
	}
	.hero-body {
		animation: hero-text 0.7s cubic-bezier(0.2, 0.8, 0.2, 1) 0.15s both;
		position: relative;
		z-index: 1;
		width: 100%;
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: 16px;
		flex-wrap: wrap;
		padding: 0 var(--gutter) 24px;
		will-change: transform, opacity;
	}
	@keyframes hero-text {
		from {
			opacity: 0;
			transform: translateY(16px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
	h1 {
		margin: 0;
		font-size: clamp(32px, 5vw, 56px);
		font-weight: 800;
		letter-spacing: -0.03em;
		line-height: 1;
	}
	.has-image h1 {
		color: #fff;
		text-shadow: 0 2px 20px rgba(0, 0, 0, 0.35);
	}
	.hero-actions {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.play {
		width: 50px;
		height: 50px;
		border-radius: 50%;
		display: grid;
		place-items: center;
		color: #fff;
		background: var(--accent);
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
		transition: transform 0.15s ease, background-color 0.15s ease;
	}
	.play:hover {
		transform: scale(1.06);
	}
	.play :global(svg) {
		margin-left: 3px;
	}

	.pill {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 34px;
		padding: 0 14px;
		border-radius: 999px;
		font-size: 13px;
		font-weight: 600;
		color: var(--text);
		/* Solid fill instead of backdrop blur over the large artist image. */
		background: var(--chrome-strong);
		transition: background-color 0.15s ease, transform 0.15s ease;
	}
	.pill:hover {
		transform: translateY(-1px);
	}
	.pill.icon {
		width: 34px;
		padding: 0;
		justify-content: center;
	}
	.has-image .pill {
		color: #fff;
		background: rgba(255, 255, 255, 0.22);
		border: 0.5px solid rgba(255, 255, 255, 0.2);
	}
	.has-image .pill:hover {
		background: rgba(255, 255, 255, 0.32);
	}

	.top-row {
		display: grid;
		grid-template-columns: minmax(180px, 240px) 1fr;
		gap: 36px;
		padding: 0 var(--gutter);
		margin-bottom: 30px;
	}
	.top-row:not(:has(.latest)) {
		grid-template-columns: 1fr;
	}
	.flush {
		margin-left: 0;
		margin-right: 0;
	}
	.top :global(.tracks) {
		display: grid;
		grid-template-columns: 1fr;
	}
	@media (min-width: 1200px) {
		.top :global(.tracks) {
			grid-template-columns: 1fr 1fr;
			column-gap: 24px;
		}
	}
	@media (max-width: 799px) {
		.top-row {
			grid-template-columns: 1fr;
		}
		.latest {
			display: none;
		}
	}
	.about {
		margin-top: 10px;
	}
	.bio {
		text-align: left;
		font-size: 14px;
		line-height: 1.55;
		color: var(--text-2);
		max-width: 80ch;
		display: -webkit-box;
		-webkit-line-clamp: 4;
		line-clamp: 4;
		-webkit-box-orient: vertical;
		overflow: hidden;
		white-space: pre-line;
		cursor: pointer;
		transition: color 0.15s ease;
	}
	.bio:hover {
		color: var(--text);
	}
	.bio.open {
		display: block;
	}
</style>