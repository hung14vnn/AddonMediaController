<script lang="ts">
	import { cachedNow, search } from '../api';
	import AlbumCard from '../components/AlbumCard.svelte';
	import ArtistCard from '../components/ArtistCard.svelte';
	import ErrorState from '../components/ErrorState.svelte';
	import Icon from '../components/Icon.svelte';
	import PlaylistCard from '../components/PlaylistCard.svelte';
	import Shelf from '../components/Shelf.svelte';
	import TrackList from '../components/TrackList.svelte';
	import { router } from '../router.svelte';

	let { id }: { id: string } = $props();

	type GenreTab = 'overview' | 'songs' | 'playlists' | 'albums' | 'artists';
	let tab = $state<GenreTab>('overview');
	let retryCount = $state(0);

	const tabs: { id: GenreTab; label: string }[] = [
		{ id: 'overview', label: 'Overview' },
		{ id: 'songs', label: 'Songs' },
		{ id: 'playlists', label: 'Playlists' },
		{ id: 'albums', label: 'Albums' },
		{ id: 'artists', label: 'Artists' },
	];

	function load(genreName: string) {
		return cachedNow(`genre:spotapi:${genreName}`, () =>
			search(genreName, { artist: 20, album: 24, song: 30, playlist: 24 }, 0, false, 'spotify')
		);
	}

	const data = $derived.by(() => {
		void retryCount;
		return load(id);
	});
</script>

<div class="page genre">
	<div class="head">
		<button
			class="back"
			onclick={() => (history.length > 1 ? history.back() : router.go('/browse'))}
		>
			<Icon name="chevronLeft" size={18} />Browse
		</button>
	</div>

	<div class="title-row">
		<h1 class="page-title">{id}</h1>
		<div class="seg" role="tablist" aria-label="Genre sections">
			{#each tabs as t (t.id)}
				<button
					role="tab"
					aria-selected={tab === t.id}
					class:on={tab === t.id}
					onclick={() => (tab = t.id)}
				>{t.label}</button>
			{/each}
		</div>
	</div>

	{#await data}
		<div class="spinner"></div>
	{:then res}
		{#if !res.songs.length && !res.albums.length && !res.playlists?.length && !res.artists.length}
			<div class="empty-state">
				<h3>No Results for {id}</h3>
				<p>Could not find music for this genre.</p>
			</div>
		{:else if tab === 'overview'}
			{#if res.songs.length}
				<h2 class="section-title">Top Songs</h2>
				<div class="pad songs"><TrackList songs={res.songs.slice(0, 10)} /></div>
			{/if}
			{#if res.playlists?.length}
				<Shelf title="Featured Playlists">
					{#each res.playlists as playlist (playlist.id)}
						<PlaylistCard {playlist} />
					{/each}
				</Shelf>
			{/if}
			{#if res.albums.length}
				<Shelf title="Albums">
					{#each res.albums as album (album.id)}
						<AlbumCard {album} />
					{/each}
				</Shelf>
			{/if}
			{#if res.artists.length}
				<Shelf title="Artists" size="artist">
					{#each res.artists as artist (artist.id)}
						<ArtistCard {artist} />
					{/each}
				</Shelf>
			{/if}
		{:else if tab === 'songs'}
			{#if res.songs.length}
				<div class="pad songs"><TrackList songs={res.songs} /></div>
			{:else}
				<div class="empty-state"><h3>No Songs</h3></div>
			{/if}
		{:else if tab === 'playlists'}
			{#if res.playlists?.length}
				<div class="grid">
					{#each res.playlists as playlist (playlist.id)}
						<PlaylistCard {playlist} />
					{/each}
				</div>
			{:else}
				<div class="empty-state"><h3>No Playlists</h3></div>
			{/if}
		{:else if tab === 'albums'}
			{#if res.albums.length}
				<div class="grid">
					{#each res.albums as album (album.id)}
						<AlbumCard {album} />
					{/each}
				</div>
			{:else}
				<div class="empty-state"><h3>No Albums</h3></div>
			{/if}
		{:else if tab === 'artists'}
			{#if res.artists.length}
				<div class="grid artists">
					{#each res.artists as artist (artist.id)}
						<ArtistCard {artist} />
					{/each}
				</div>
			{:else}
				<div class="empty-state"><h3>No Artists</h3></div>
			{/if}
		{/if}
	{:catch error}
		<ErrorState {error} retry={() => retryCount++} />
	{/await}
</div>

<style>
	.head {
		display: flex;
		align-items: center;
		padding: 0 var(--gutter);
		margin-bottom: 8px;
	}
	.back {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		color: var(--accent);
		font-size: 14px;
		white-space: nowrap;
	}
	.title-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		margin-bottom: 16px;
	}
	.title-row .page-title {
		margin-bottom: 0;
	}
	.seg {
		display: flex;
		padding: 2px;
		border-radius: 9px;
		background: var(--fill);
		margin-right: var(--gutter);
	}
	.seg button {
		height: 28px;
		padding: 0 14px;
		border-radius: 7px;
		font-size: 13px;
		font-weight: 500;
		color: var(--text-2);
		white-space: nowrap;
	}
	.seg button.on {
		color: var(--text);
		background: var(--bg-elevated);
		box-shadow: 0 1px 4px rgb(0 0 0 / 0.12);
	}
	.songs {
		margin-bottom: 24px;
	}
	@media (max-width: 899px) {
		.title-row {
			flex-direction: column;
			align-items: flex-start;
			gap: 12px;
		}
		.seg {
			margin-left: var(--gutter);
			width: calc(100% - 2 * var(--gutter));
			overflow-x: auto;
			border-radius: 999px;
		}
		.seg button {
			flex: 1;
			border-radius: 999px;
			height: 32px;
		}
	}
</style>
