<script lang="ts">
	import { getAlbum } from '../api';
	import { artistName } from '../format';
	import { albumMenu } from '../menus';
	import { getPlayer } from '../player.svelte';
	import { href } from '../router.svelte';
	import type { Album } from '../types';
	import { ui } from '../ui.svelte';
	import Card from './Card.svelte';

	let { album, showYear = false }: { album: Album; showYear?: boolean } = $props();

	async function play() {
		const songs = album.song ?? (await getAlbum(album.id)).song ?? [];
		getPlayer().playList(songs);
	}
</script>

<Card
	href={href.album(album.id)}
	coverArt={album.coverArt}
	title={album.name}
	subtitle={showYear ? (album.year ? String(album.year) : '') : artistName(album)}
	subtitleHref={!showYear && album.artistId ? href.artist(album.artistId) : undefined}
	explicit={album.explicitStatus === 'explicit'}
	icon="album"
	onplay={play}
	onmenu={(e) => ui.openMenu(e, albumMenu(album))}
/>
