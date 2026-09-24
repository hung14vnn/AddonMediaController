<script lang="ts">
	import { href, router } from '../router.svelte';
	import { getSession } from '../api';
	import { ui } from '../ui.svelte';
	import Avatar from './Avatar.svelte';
	import Icon from './Icon.svelte';

	const session = getSession();

	let query = $state(router.route.name === 'search' ? router.route.query : '');
	let timer: ReturnType<typeof setTimeout> | undefined;

	function onSearch() {
		clearTimeout(timer);
		timer = setTimeout(() => router.go(`/search?q=${encodeURIComponent(query)}`, router.route.name === 'search'), 220);
	}

	const r = $derived(router.route);
	const activeId = $derived('id' in r ? r.id : null);

	const top = [
		{ path: '/', name: 'home', label: 'Home', icon: 'home' },
		{ path: '/browse', name: 'browse', label: 'Browse', icon: 'browse' }
	];
	const library = [
		{ path: '/recent', name: 'recent', label: 'Recently Added', icon: 'clock' },
		{ path: '/artists', name: 'artists', label: 'Artists', icon: 'mic' },
		{ path: '/albums', name: 'albums', label: 'Albums', icon: 'album' },
		{ path: '/songs', name: 'songs', label: 'Songs', icon: 'note' },
		{ path: '/loved', name: 'loved', label: 'Favorites', icon: 'star' },
		{ path: '/genres', name: 'genres', label: 'Genres', icon: 'browse' }
	];

	async function newPlaylist() {
		const name = prompt('Playlist name', 'New Playlist');
		if (name?.trim()) await ui.createPlaylistWith(name.trim(), []);
	}
</script>

<nav class="sidebar" aria-label="Main">
	<div class="brand">
		<span class="logo"><Icon name="note" size={16} /></span>
		<span>hify</span>
	</div>

	<label class="search">
		<Icon name="search" size={15} />
		<input
			type="search"
			placeholder="Search"
			bind:value={query}
			oninput={onSearch}
			onfocus={() => router.route.name !== 'search' && router.go(`/search?q=${encodeURIComponent(query)}`)}
		/>
	</label>

	<div class="scroll">
		<ul>
			{#each top as item}
				<li>
					<a href="#{item.path}" class:active={r.name === item.name}>
						<Icon name={item.icon} size={18} />{item.label}
					</a>
				</li>
			{/each}
		</ul>

		<h4>Library</h4>
		<ul>
			{#each library as item}
				<li>
					<a href="#{item.path}" class:active={r.name === item.name}>
						<Icon name={item.icon} size={18} />{item.label}
					</a>
				</li>
			{/each}
		</ul>

		<h4>
			<a href="#/playlists" class:active-h={r.name === 'playlists'}>Playlists</a>
			<button aria-label="New Playlist" onclick={newPlaylist}><Icon name="plus" size={16} /></button>
		</h4>
		<ul>
			{#each ui.playlists as pl (pl.id)}
				<li>
					<a href={href.playlist(pl.id)} class:active={r.name === 'playlist' && activeId === pl.id}>
						<Icon name="playlist" size={18} /><span class="ellipsis">{pl.name}</span>
					</a>
				</li>
			{/each}
		</ul>
	</div>

	<a class="me" href="#/profile" class:active={r.name === 'profile'}>
		<Avatar username={ui.me?.username ?? session?.username} size={28} />
		<span class="me-text">
			<span class="ellipsis">{ui.me?.username ?? session?.username ?? 'Account'}</span>
			<small>{ui.me?.adminRole ? 'Administrator' : 'Account & Settings'}</small>
		</span>
	</a>
</nav>

<style>
	.sidebar {
		height: 100%;
		display: flex;
		flex-direction: column;
		padding: 16px 10px 10px;
		background: var(--sidebar);
		border-right: 0.5px solid var(--hairline);
		backdrop-filter: saturate(1.8) blur(30px);
		-webkit-backdrop-filter: saturate(1.8) blur(30px);
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 7px;
		font-size: 21px;
		font-weight: 700;
		letter-spacing: -0.02em;
		padding: 0 10px 14px;
	}
	.logo {
		width: 24px;
		height: 24px;
		border-radius: 6px;
		display: grid;
		place-items: center;
		color: #fff;
		background: linear-gradient(#fb5c74, #fa233b);
	}
	.search {
		display: flex;
		align-items: center;
		gap: 6px;
		height: 30px;
		margin: 0 4px 12px;
		padding: 0 8px;
		border-radius: 8px;
		background: var(--fill);
		color: var(--text-2);
		box-shadow: inset 0 0 0 0.5px var(--hairline);
	}
	.search:focus-within {
		box-shadow: 0 0 0 3px var(--accent-soft), inset 0 0 0 1px var(--accent);
	}
	.search input {
		flex: 1;
		min-width: 0;
		border: 0;
		background: none;
		outline: none;
		font: inherit;
		font-size: 13px;
		color: var(--text);
	}
	.scroll {
		flex: 1;
		overflow-y: auto;
		scrollbar-width: thin;
	}
	ul {
		list-style: none;
		margin: 0 0 8px;
		padding: 0;
	}
	h4 {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin: 14px 10px 4px;
		font-size: 11px;
		font-weight: 600;
		color: var(--text-3);
		text-transform: none;
	}
	h4 a {
		color: inherit;
	}
	h4 a:hover,
	.active-h {
		color: var(--text);
	}
	h4 button {
		color: var(--text-3);
		display: grid;
		place-items: center;
		width: 22px;
		height: 22px;
		border-radius: 5px;
	}
	h4 button:hover {
		color: var(--text);
		background: var(--hover);
	}
	li a {
		display: flex;
		align-items: center;
		gap: 9px;
		height: 30px;
		padding: 0 10px;
		border-radius: 7px;
		font-size: 13px;
		color: var(--text);
		min-width: 0;
		transition: background-color 0.18s ease;
	}
	li a :global(svg) {
		color: var(--accent);
		flex-shrink: 0;
	}
	li a:hover {
		background: var(--hover);
	}
	li a.active {
		background: var(--selected);
	}
	.me {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 8px;
		margin-top: 6px;
		border-radius: 9px;
		transition: background-color 0.18s ease;
	}
	.me:hover {
		background: var(--hover);
	}
	.me.active {
		background: var(--selected);
	}
	.me-text {
		display: flex;
		flex-direction: column;
		min-width: 0;
		font-size: 13px;
		font-weight: 500;
		line-height: 1.25;
	}
	.me-text small {
		font-size: 11px;
		font-weight: 400;
		color: var(--text-2);
	}
</style>
