<script lang="ts">
	import Card from '../components/Card.svelte';
	import Icon from '../components/Icon.svelte';
	import { plural } from '../format';
	import { playlistMenu, playlistSongs } from '../menus';
	import { getPlayer } from '../player.svelte';
	import { href } from '../router.svelte';
	import { router } from '../router.svelte';
	import { ui } from '../ui.svelte';

	const player = getPlayer();
	let loading = $state(true);
	let sort = $state<'title' | 'added' | 'played' | 'updated' | 'type'>('title');
	ui.refreshPlaylists().finally(() => (loading = false));
	const sortedPlaylists = $derived([...ui.playlists].sort((a, b) => {
		if (sort === 'added' || sort === 'played') return (b.changed ?? '').localeCompare(a.changed ?? '');
		if (sort === 'updated') return (b.changed ?? '').localeCompare(a.changed ?? '');
		if (sort === 'type') return (a.public === b.public ? 0 : a.public ? -1 : 1);
		return a.name.localeCompare(b.name);
	}));

	async function create() {
		const name = prompt('Playlist name', 'New Playlist');
		if (name?.trim()) await ui.createPlaylistWith(name.trim(), []);
	}
</script>

<div class="page">
	<div class="head">
		<button class="back" onclick={() => router.go('/library')}><Icon name="chevronLeft" size={18} />Library</button>
		<label class="sort"><span>Sort</span><select bind:value={sort}><option value="title">Title</option><option value="added">Recently Added</option><option value="played">Recently Played</option><option value="updated">Recently Updated</option><option value="type">Playlist Type</option></select></label>
	</div>
	<h1 class="page-title">Playlists</h1>
	<div class="playlist-action"><button class="btn secondary" onclick={create}><Icon name="plus" size={16} />New Playlist</button></div>
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
			{#each sortedPlaylists as pl (pl.id)}
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
		margin-bottom: 8px;
	}
	.back { display: inline-flex; align-items: center; gap: 2px; color: var(--accent); font-size: 14px; white-space: nowrap; }
	.sort { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-2); margin-left: auto; }
	select { color: var(--text); background: var(--fill); border: 0; border-radius: 7px; padding: 7px 6px; font: inherit; }
	.sort { position: relative; color: var(--accent); }
	.sort select { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; }
	.head .page-title {
		margin-bottom: 20px;
	}
	.head .btn {
		margin-bottom: 20px;
		min-width: 0;
	}
	.playlist-action { display: flex; justify-content: flex-end; margin: -8px var(--gutter) 16px; }
	.playlist-action .btn { min-width: 0; }
	@media (max-width: 699px) {
		.playlist-action { margin: -4px 10px 16px; }
		.playlist-action .btn { height: 32px; padding: 0 10px; border-radius: 7px; font-size: 11px; }
		.playlist-action .btn :global(svg) { width: 13px; height: 13px; }
		:global(.page > .grid) { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; padding: 0 4px; }
		:global(.page > .grid) { padding-left: 20px; padding-right: 20px; }
	}
</style>
