<script lang="ts">
	import { getPlaylist } from '../api';
	import { playlistMenu } from '../menus';
	import { getPlayer } from '../player.svelte';
	import { href } from '../router.svelte';
	import type { Playlist } from '../types';
	import { ui } from '../ui.svelte';
	import Card from './Card.svelte';

	let { playlist }: { playlist: Playlist } = $props();

	async function play() {
		const songs = playlist.entry ?? (await getPlaylist(playlist.id)).entry ?? [];
		getPlayer().playList(songs);
	}
</script>

<Card
	href={href.playlist(playlist.id)}
	coverArt={playlist.coverArt}
	title={playlist.name}
	subtitle={playlist.owner}
	icon="playlist"
	onplay={play}
	onmenu={(e) => ui.openMenu(e, playlistMenu(playlist))}
/>
