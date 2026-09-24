<script lang="ts">
	import { href } from '../router.svelte';
	import type { Artist } from '../types';
	import Artwork from './Artwork.svelte';

	let { artist }: { artist: Artist } = $props();
</script>

<a class="artist" href={href.artist(artist.id)}>
	<Artwork id={artist.coverArt} src={artist.artistImageUrl} seed={artist.name} round icon="mic" />
	<span class="name">{artist.name}</span>
</a>

<style>
	.artist {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		min-width: 0;
		text-align: center;
		color: var(--text);
		font-size: 13px;
		font-weight: 500;
	}
	.artist :global(.art) {
		transition: transform 0.2s ease;
	}
	.artist:hover :global(.art) {
		transform: scale(1.03);
	}
	.name {
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
