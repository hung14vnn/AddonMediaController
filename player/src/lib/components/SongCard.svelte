<script lang="ts">
	import { songMenu } from '../menus';
	import { getPlayer } from '../player.svelte';
	import { href } from '../router.svelte';
	import type { Song } from '../types';
	import { ui } from '../ui.svelte';
	import ArtistLinks from './ArtistLinks.svelte';
	import Card from './Card.svelte';

	let { song }: { song: Song } = $props();

	function play() {
		getPlayer().playList([song]);
	}

	let menuItems = $state<any[]>([]);
	$effect(() => {
		songMenu(song).then((items) => (menuItems = items));
	});
</script>

{#snippet artists()}
	<ArtistLinks class="subtitle" item={song} />
{/snippet}

<Card
	href={song.albumId ? href.album(song.albumId) : '#'}
	coverArt={song.coverArt}
	title={song.title}
	subtitleSlot={artists}
	icon="note"
	onplay={play}
	onmenu={(e) => ui.openMenu(e, menuItems)}
/>
