<script lang="ts">
	import Card from '../components/Card.svelte';
	import Icon from '../components/Icon.svelte';
	import { plural } from '../format';
	import { playlistMenu, playlistSongs } from '../menus';
	import { getPlayer } from '../player.svelte';
	import { href } from '../router.svelte';
	import { ui } from '../ui.svelte';

	const player = getPlayer();
	let loading = $state(true);
	ui.refreshPlaylists().finally(() => (loading = false));

	async function create() {
		const name = prompt('Playlist name', 'New Playlist');
		if (name?.trim()) await ui.createPlaylistWith(name.trim(), []);
	}
</script>

<div class="page">
	<div class="head">
		<h1 class="page-title">Playlists</h1>
		<button class="btn secondary" onclick={create}><Icon name="plus" size={16} />New Playlist</button>
	</div>
	{#if loading && !ui.playlists.length}
		<div class="spinner"></div>
	{:else if !ui.playlists.length}
		<div class="empty-state">
			<Icon name="playlist" size={44} />
			<h3>No Playlists</h3>
			<p>Create one, or use “Add to Playlist…” on any song.</p>
		</div>
	{:else}
		<div class="grid">
			{#each ui.playlists as pl (pl.id)}
				<Card
					href={href.playlist(pl.id)}
					coverArt={pl.coverArt}
					title={pl.name}
					subtitle={plural(pl.songCount ?? 0, 'song')}
					icon="playlist"
					onplay={async () => player.playList(await playlistSongs(pl))}
					onmenu={(e) => ui.openMenu(e, playlistMenu(pl))}
				/>
			{/each}
		</div>
	{/if}
</div>

<style>
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding-right: var(--gutter);
	}
	.head .page-title {
		margin-bottom: 20px;
	}
	.head .btn {
		margin-bottom: 20px;
		min-width: 0;
	}
</style>
