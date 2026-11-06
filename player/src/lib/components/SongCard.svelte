<script lang="ts">
	import { songMenu } from '../menus';
	import { getPlayer } from '../player.svelte';
	import type { Song } from '../types';
	import { ui } from '../ui.svelte';
	import ArtistLinks from './ArtistLinks.svelte';
	import Card from './Card.svelte';

	let {
		song,
		queue,
		index = 0
	}: {
		song: Song;
		queue?: Song[];
		index?: number;
	} = $props();

	function play() {
		const p = getPlayer();
		if (queue && queue.length > 0) {
			p.playList(queue, index);
		} else {
			p.playList([song]);
		}
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
	coverArt={song.coverArt}
	title={song.title}
	subtitleSlot={artists}
	icon="note"
	onclick={play}
	onplay={play}
	onmenu={(e) => ui.openMenu(e, menuItems)}
/>
