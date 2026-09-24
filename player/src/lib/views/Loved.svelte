<script lang="ts">
	import { getStarred } from '../api';
	import AlbumCard from '../components/AlbumCard.svelte';
	import ArtistCard from '../components/ArtistCard.svelte';
	import ErrorState from '../components/ErrorState.svelte';
	import Icon from '../components/Icon.svelte';
	import Shelf from '../components/Shelf.svelte';
	import TrackList from '../components/TrackList.svelte';
	import { getPlayer } from '../player.svelte';

	const player = getPlayer();
	let data = $state(getStarred());
</script>

<div class="page">
	<h1 class="page-title">Favorites</h1>
	{#await data}
		<div class="spinner"></div>
	{:then s}
		{#if !s.songs.length && !s.albums.length && !s.artists.length}
			<div class="empty-state">
				<Icon name="star" size={44} />
				<h3>No Favorites Yet</h3>
				<p>Tap the star on songs, albums and artists you love.</p>
			</div>
		{:else}
			{#if s.albums.length}
				<Shelf title="Albums">
					{#each s.albums as album (album.id)}<AlbumCard {album} />{/each}
				</Shelf>
			{/if}
			{#if s.artists.length}
				<Shelf title="Artists" size="artist">
					{#each s.artists as artist (artist.id)}<ArtistCard {artist} />{/each}
				</Shelf>
			{/if}
			{#if s.songs.length}
				<div class="songs-head">
					<h2 class="section-title">Songs</h2>
					<div class="actions">
						<button class="btn secondary" onclick={() => player.playList(s.songs)}><Icon name="play" size={14} />Play</button>
						<button class="btn secondary" onclick={() => player.playList(s.songs, 0, { shuffle: true })}><Icon name="shuffle" size={14} />Shuffle</button>
					</div>
				</div>
				<div class="pad"><TrackList songs={s.songs} /></div>
			{/if}
		{/if}
	{:catch error}
		<ErrorState {error} retry={() => (data = getStarred())} />
	{/await}
</div>

<style>
	.songs-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding-right: var(--gutter);
		margin-bottom: 6px;
	}
	.songs-head .section-title {
		margin-bottom: 0;
	}
	.songs-head .btn {
		min-width: 0;
		height: 28px;
		padding: 0 12px;
		font-size: 13px;
		flex: none !important;
	}
</style>
