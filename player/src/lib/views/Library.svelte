<script lang="ts">
	// Mobile Library tab landing page (desktop reaches these from the sidebar).
	import { getAlbumList } from '../api';
	import AlbumCard from '../components/AlbumCard.svelte';
	import Icon from '../components/Icon.svelte';
	import ProfileButton from '../components/ProfileButton.svelte';

	const rows = [
		{ path: '/playlists', label: 'Playlists', icon: 'playlist' },
		{ path: '/artists', label: 'Artists', icon: 'mic' },
		{ path: '/albums', label: 'Albums', icon: 'album' },
		{ path: '/songs', label: 'Songs', icon: 'note' },
		{ path: '/loved', label: 'Favorites', icon: 'star' },
		{ path: '/genres', label: 'Genres', icon: 'browse' }
	];
	const recent = getAlbumList('newest', 12).catch(() => []);
</script>

<div class="page">
	<div class="head">
		<h1 class="page-title">Library</h1>
		<ProfileButton />
	</div>
	<ul class="rows">
		{#each rows as row}
			<li>
				<a href="#{row.path}">
					<Icon name={row.icon} size={22} />
					<span>{row.label}</span>
					<Icon name="chevronRight" size={16} class="chev" />
				</a>
			</li>
		{/each}
	</ul>

	{#await recent then albums}
		{#if albums.length}
			<h2 class="section-title">Recently Added</h2>
			<div class="grid">
				{#each albums as album (album.id)}<AlbumCard {album} />{/each}
			</div>
		{/if}
	{/await}

</div>

<style>
	.rows {
		list-style: none;
		margin: 0 0 28px;
		padding: 0 0 0 var(--gutter);
	}
	.rows a {
		display: flex;
		align-items: center;
		gap: 14px;
		height: 48px;
		font-size: 20px;
		border-bottom: 0.5px solid var(--hairline);
		padding-right: var(--gutter);
	}
	.rows a :global(svg:first-child) {
		color: var(--accent);
	}
	.rows span {
		flex: 1;
	}
	.rows :global(.chev) {
		color: var(--text-3);
	}
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding-right: var(--gutter);
		margin-bottom: 20px;
	}
	.head .page-title {
		margin-bottom: 0;
	}
</style>
