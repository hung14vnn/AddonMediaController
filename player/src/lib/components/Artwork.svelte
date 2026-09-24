<script lang="ts">
	import { coverUrl } from '../api';
	import { hue } from '../format';
	import Icon from './Icon.svelte';

	let {
		id,
		size = 300,
		alt = '',
		round = false,
		src: explicitSrc,
		seed = '',
		icon = 'note'
	}: {
		id?: string;
		size?: number;
		alt?: string;
		round?: boolean;
		src?: string;
		seed?: string;
		icon?: string;
	} = $props();

	let failed = $state(false);
	let loaded = $state(false);
	const src = $derived(explicitSrc || coverUrl(id, size * (window.devicePixelRatio > 1 ? 2 : 1)));

	$effect(() => {
		void src;
		failed = false;
		loaded = false;
	});
</script>

<div class="art" class:round style:--h={hue(seed || id || alt)}>
	{#if src && !failed}
		<img {src} {alt} loading="lazy" decoding="async" class:loaded onload={() => (loaded = true)} onerror={() => (failed = true)} />
	{/if}
	{#if !src || failed || !loaded}
		<div class="placeholder"><Icon name={icon} size={Math.max(20, Math.min(64, size / 4))} /></div>
	{/if}
</div>

<style>
	.art {
		position: relative;
		width: 100%;
		aspect-ratio: 1;
		border-radius: var(--art-radius, 8px);
		overflow: hidden;
		background: var(--fill);
		box-shadow: var(--art-shadow, inset 0 0 0 0.5px var(--hairline));
		flex-shrink: 0;
	}
	.round {
		border-radius: 50%;
	}
	img {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
		opacity: 0;
		transition: opacity 0.25s ease;
	}
	img.loaded {
		opacity: 1;
	}
	.placeholder {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		color: hsl(var(--h) 20% 60% / 0.9);
		background: linear-gradient(145deg, hsl(var(--h) 16% var(--ph-l1)), hsl(var(--h) 12% var(--ph-l2)));
	}
</style>
