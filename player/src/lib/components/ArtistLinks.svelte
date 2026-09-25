<script lang="ts">
	import { artistName } from '../format';
	import { href } from '../router.svelte';
	import type { Song } from '../types';

	let {
		item,
		class: className = '',
		onclick
	}: {
		item: Song | { artist?: string; artistId?: string; displayArtist?: string };
		class?: string;
		onclick?: (e: MouseEvent) => void;
	} = $props();

	const artists = $derived.by(() => {
		const name = artistName(item);
		// Assuming artists are joined by ", " from the backend.
		const parts = name.split(', ').filter(Boolean);
		return parts.map((part, i) => {
			return {
				name: part,
				url: href.artist(i === 0 && item.artistId ? item.artistId : part)
			};
		});
	});
</script>

<span class={className}>
	{#each artists as artist, i}
		<a
			href={artist.url}
			onclick={(e) => {
				if (onclick) onclick(e);
			}}>{artist.name}</a
		>{#if i < artists.length - 1},&nbsp;{/if}
	{/each}
</span>

<style>
	a:hover {
		text-decoration: underline;
	}
</style>
