<script lang="ts">
	import { cachedNow, getAlbum, getAlbumList, getArtist } from '../api';
	import type { Album } from '../types';
	import AlbumCard from '../components/AlbumCard.svelte';
	import DetailHeader from '../components/DetailHeader.svelte';
	import ErrorState from '../components/ErrorState.svelte';
	import Icon from '../components/Icon.svelte';
	import Shelf from '../components/Shelf.svelte';
	import TrackList from '../components/TrackList.svelte';
	import { artistName, plural, totalDuration } from '../format';
	import { albumMenu } from '../menus';
	import { artworkTint } from '../palette';
	import { getPlayer } from '../player.svelte';
	import { href } from '../router.svelte';
	import { ui } from '../ui.svelte';

	let { id }: { id: string } = $props();
	const player = getPlayer();

	// Revisited in the same session this is all synchronous, so the page paints its last
	// state in the same frame; a changed album swaps in when the server answers.
	function load(albumId: string) {
		const album = cachedNow(`album:${albumId}`, () => getAlbum(albumId), {
			fresh: 0,
			refresh: (a) => (data = assemble(a))
		});
		return album instanceof Promise ? album.then(assemble) : assemble(album);
	}

	function assemble(album: Album) {
		const more = album.artistId
			? Promise.resolve(cachedNow(`artist:${album.artistId}`, () => getArtist(album.artistId!)))
					.then((a) => (a.album ?? []).filter((x) => x.id !== album.id))
					.catch(() => [])
			: album.genre
				? getAlbumList('byGenre', 12, 0, { genre: album.genre }).then((l) => l.filter((x) => x.id !== album.id))
				: Promise.resolve([]);
		const tint = album.coverArt ? artworkTint(album.coverArt) : null;
		const finish = (t: Awaited<typeof tint>) => ({ album, more, tint: t?.top ?? null });
		return tint instanceof Promise ? tint.then(finish) : finish(tint);
	}

	let data = $derived(load(id));
</script>

{#await data}
	<div class="spinner"></div>
{:then { album, more, tint }}
	{@const songs = album.song ?? []}
	<div class="page album-page" style:--hero-bg={tint}>
		<DetailHeader
			coverArt={album.coverArt}
			title={album.name}
			subtitle={artistName(album)}
			subtitleHref={album.artistId ? href.artist(album.artistId) : undefined}
			meta={[album.genre, album.year].filter(Boolean).join(' · ')}
			{songs}
			onmore={(e) => ui.openMenu(e, albumMenu(album))}
		>
			{#snippet actions()}
				<div class="actions">
					<button class="btn" onclick={() => player.playList(songs)}><Icon name="play" size={16} />Play</button>
					<button class="btn" onclick={() => player.playList(songs, 0, { shuffle: true })}><Icon name="shuffle" size={16} />Shuffle</button>
					<button class="btn icon-only" aria-label="Favorite" onclick={() => ui.toggleLove('album', album)}>
						<Icon name={ui.isLoved(album) ? 'starFill' : 'star'} size={18} />
					</button>
					<button class="btn icon-only" aria-label="More options" onclick={(e) => ui.openMenu(e, albumMenu(album))}>
						<Icon name="more" size={18} />
					</button>
				</div>
			{/snippet}
		</DetailHeader>

		<div class="pad">
			<TrackList {songs} variant="album" albumArtist={artistName(album)} />
			<p class="footer muted">
				{#if album.year}{album.year}<br />{/if}
				{plural(songs.length, 'song')}, {totalDuration(songs)}
			</p>
		</div>

		{#await more then others}
			{#if others.length}
				<Shelf title={album.artistId ? `More by ${artistName(album)}` : 'You Might Also Like'} seeAll={album.artistId ? href.artist(album.artistId) : undefined}>
					{#each others as a (a.id)}<AlbumCard album={a} showYear={!!album.artistId} />{/each}
				</Shelf>
			{/if}
		{/await}
	</div>
{:catch error}
	<ErrorState {error} retry={() => (data = load(id))} />
{/await}

<style>
	.album-page {
		--hero-bg: var(--bg);
	}
	@media (max-width: 899px) {
		.album-page {
			min-height: calc(100vh + 128px + env(safe-area-inset-bottom));
			background: var(--hero-bg);
			transition: background-color 0.4s ease;
		}
	}
	.footer {
		margin: 16px 10px 36px;
		font-size: 13px;
		line-height: 1.6;
	}
	@media (max-width: 699px) {
		.album-page {
			color: #fff;
		}
		.album-page :global(.section-title),
		.album-page :global(.shelf .title),
		.album-page :global(.tracks .title),
		.album-page :global(.tracks .artist),
		.album-page :global(.tracks .duration),
		.album-page :global(.tracks .num),
		.album-page :global(.card .title),
		.album-page :global(.muted),
		.album-page :global(.more) {
			color: #fff !important;
		}
		.album-page :global(.card .subtitle) {
			color: rgb(255 255 255 / 0.72) !important;
		}
	}
</style>
