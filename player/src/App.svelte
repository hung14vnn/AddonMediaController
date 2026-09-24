<script lang="ts">
	import { clearSession, getSession } from './lib/api';
	import MiniPlayer from './lib/components/MiniPlayer.svelte';
	import NowPlaying from './lib/components/NowPlaying.svelte';
	import Overlays from './lib/components/Overlays.svelte';
	import PlayerBar from './lib/components/PlayerBar.svelte';
	import Sidebar from './lib/components/Sidebar.svelte';
	import TabBar from './lib/components/TabBar.svelte';
	import { getPlayer } from './lib/player.svelte';
	import { router } from './lib/router.svelte';
	import { pageIn } from './lib/motion';
	import { ui } from './lib/ui.svelte';
	import Album from './lib/views/Album.svelte';
	import AlbumGrid from './lib/views/AlbumGrid.svelte';
	import Artist from './lib/views/Artist.svelte';
	import Artists from './lib/views/Artists.svelte';
	import Browse from './lib/views/Browse.svelte';
	import Genre from './lib/views/Genre.svelte';
	import Genres from './lib/views/Genres.svelte';
	import Home from './lib/views/Home.svelte';
	import Library from './lib/views/Library.svelte';
	import Login from './lib/views/Login.svelte';
	import Loved from './lib/views/Loved.svelte';
	import Playlist from './lib/views/Playlist.svelte';
	import Playlists from './lib/views/Playlists.svelte';
	import Profile from './lib/views/Profile.svelte';
	import Search from './lib/views/Search.svelte';
	import Songs from './lib/views/Songs.svelte';

	let signedIn = $state(!!getSession());
	let main: HTMLElement | undefined = $state();

	const route = $derived(router.route);
	// Remount the view per path so each page starts fresh (search keeps its instance).
	const viewKey = $derived(route.name === 'search' ? 'search' : location.hash);

	$effect(() => {
		if (signedIn) {
			ui.refreshPlaylists();
			ui.loadMe();
		}
	});

	$effect(() => {
		void viewKey;
		main?.scrollTo({ top: 0 });
	});

	function signOut() {
		getPlayer().reset();
		clearSession();
		ui.nowPlaying = false;
		ui.me = null;
		ui.playlists = [];
		signedIn = false;
		router.go('/', true);
	}

	function onKey(e: KeyboardEvent) {
		const t = e.target as HTMLElement;
		if (t.closest('input, textarea, select, [contenteditable]')) return;
		const player = getPlayer();
		if (e.code === 'Space') {
			e.preventDefault();
			player.toggle();
		} else if ((e.metaKey || e.ctrlKey) && e.key === 'ArrowRight') player.next();
		else if ((e.metaKey || e.ctrlKey) && e.key === 'ArrowLeft') player.previous();
	}
</script>

<svelte:window onkeydown={signedIn ? onKey : undefined} />

{#if !signedIn}
	<Login onlogin={() => (signedIn = true)} />
{:else}
	{@const player = getPlayer()}
	<div class="app" class:has-mini={!!player.current}>
		<aside class="side"><Sidebar /></aside>
		<div class="bar"><PlayerBar /></div>
		<main bind:this={main}>
			{#key viewKey}
				<div class="view" in:pageIn>
				{#if route.name === 'home'}<Home />
				{:else if route.name === 'browse'}<Browse />
				{:else if route.name === 'search'}<Search query={route.query} />
				{:else if route.name === 'library'}<Library />
				{:else if route.name === 'profile'}<Profile onsignout={signOut} />
				{:else if route.name === 'recent'}<AlbumGrid title="Recently Added" initialType="newest" limit={300} />
				{:else if route.name === 'albums'}<AlbumGrid title="Albums" sortable />
				{:else if route.name === 'artists'}<Artists />
				{:else if route.name === 'songs'}<Songs />
				{:else if route.name === 'playlists'}<Playlists />
				{:else if route.name === 'loved'}<Loved />
				{:else if route.name === 'genres'}<Genres />
				{:else if route.name === 'genre'}<Genre id={route.id} />
				{:else if route.name === 'album'}<Album id={route.id} />
				{:else if route.name === 'artist'}<Artist id={route.id} />
				{:else if route.name === 'playlist'}<Playlist id={route.id} />
				{/if}
				</div>
			{/key}
		</main>
		<div class="dock">
			<MiniPlayer />
			<TabBar />
		</div>
	</div>
	{#if ui.nowPlaying}<NowPlaying />{/if}
	<Overlays />
{/if}

<style>
	.app {
		height: 100%;
		display: grid;
		grid-template-columns: var(--sidebar-w) minmax(0, 1fr);
		grid-template-rows: var(--bar-h) minmax(0, 1fr);
		grid-template-areas:
			'side bar'
			'side main';
	}
	.side {
		grid-area: side;
		min-height: 0;
	}
	.bar {
		grid-area: bar;
		z-index: 5;
	}
	main {
		grid-area: main;
		overflow-y: auto;
		overflow-x: hidden;
		min-height: 0;
		scrollbar-gutter: stable;
	}
	.dock {
		display: none;
	}

	/* Phone/tablet: tab bar + floating mini player instead of sidebar + top bar. */
	@media (max-width: 899px) {
		.app {
			display: block;
		}
		.side,
		.bar {
			display: none;
		}
		main {
			height: 100%;
			padding-bottom: calc(64px + env(safe-area-inset-bottom));
		}
		.has-mini main {
			padding-bottom: calc(128px + env(safe-area-inset-bottom));
		}
		.dock {
			display: block;
			position: fixed;
			left: 0;
			right: 0;
			bottom: 0;
			z-index: 10;
			pointer-events: none;
		}
		.dock > :global(*) {
			pointer-events: auto;
		}
		:global(:root) {
			--toast-offset: 140px;
		}
	}
</style>
