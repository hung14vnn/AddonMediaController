<script lang="ts">
	import { getAlbum, getAlbumList, getArtist } from '../api';
	import AlbumCard from '../components/AlbumCard.svelte';
	import DetailHeader from '../components/DetailHeader.svelte';
	import ErrorState from '../components/ErrorState.svelte';
	import Icon from '../components/Icon.svelte';
	import Shelf from '../components/Shelf.svelte';
	import TrackList from '../components/TrackList.svelte';
	import { artistName, plural, totalDuration } from '../format';
	import { albumMenu } from '../menus';
	import { getPlayer } from '../player.svelte';
	import { href } from '../router.svelte';
	import { ui } from '../ui.svelte';

	let { id }: { id: string } = $props();
	const player = getPlayer();

	async function load(albumId: string) {
		const album = await getAlbum(albumId);
		const more = album.artistId
			? getArtist(album.artistId)
					.then((a) => (a.album ?? []).filter((x) => x.id !== album.id))
					.catch(() => [])
			: album.genre
				? getAlbumList('byGenre', 12, 0, { genre: album.genre }).then((l) => l.filter((x) => x.id !== album.id))
				: Promise.resolve([]);
		return { album, more };
	}

	let data = $derived(load(id));
</script>

{#await data}
	<div class="spinner"></div>
{:then { album, more }}
	{@const songs = album.song ?? []}
	<div class="page">
		<DetailHeader
			coverArt={album.coverArt}
			title={album.name}
			subtitle={artistName(album)}
			subtitleHref={album.artistId ? href.artist(album.artistId) : undefined}
			meta={[album.genre, album.year].filter(Boolean).join(' · ')}
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
	.footer {
		margin: 16px 10px 36px;
		font-size: 13px;
		line-height: 1.6;
	}
</style>
