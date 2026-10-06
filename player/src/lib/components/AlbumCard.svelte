<script lang="ts">
	import { getAlbum } from "../api";
	import { albumMenu } from "../menus";
	import { artworkTint } from "../palette";
	import { getPlayer } from "../player.svelte";
	import { href } from "../router.svelte";
	import type { Album } from "../types";
	import { ui } from "../ui.svelte";
	import ArtistLinks from "./ArtistLinks.svelte";
	import Card from "./Card.svelte";

	let { album, showYear = false }: { album: Album; showYear?: boolean } =
		$props();

	// Start loading the album page's data on press, ahead of the click.
	function prefetch() {
		getAlbum(album.id).catch(() => {});
		if (album.coverArt) void artworkTint(album.coverArt);
	}

	async function play() {
		const songs = album.song ?? (await getAlbum(album.id)).song ?? [];
		getPlayer().playList(songs);
	}
</script>

{#snippet artists()}
	<ArtistLinks class="subtitle" item={album} />
{/snippet}

{#if !ui.removedAlbums.has(album.id)}
<Card
	href={href.album(album.id)}
	coverArt={album.coverArt}
	title={album.name}
	subtitle={showYear ? (album.year ? String(album.year) : "") : undefined}
	subtitleSlot={!showYear ? artists : undefined}
	explicit={album.explicitStatus === "explicit"}
	icon="album"
	onplay={play}
	onmenu={(e) => ui.openMenu(e, albumMenu(album))}
	onprefetch={prefetch}
/>
{/if}
