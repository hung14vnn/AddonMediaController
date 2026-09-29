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
		icon = 'note',
		cropWide = false
	}: {
		id?: string;
		size?: number;
		alt?: string;
		round?: boolean;
		src?: string;
		seed?: string;
		icon?: string;
		cropWide?: boolean;
	} = $props();

	let failed = $state(false);
	let loaded = $state(false);
	let cropScale = $state(1);

	// TỐI ƯU 1: Tính toán DPR an toàn với cả môi trường SSR / Window
	const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio > 1 ? 2 : 1) : 1;
	const src = $derived(explicitSrc || coverUrl(id, size * dpr));

	$effect(() => {
		void src;
		failed = false;
		loaded = false;
		cropScale = 1;
	});

	function handleLoad(event: Event) {
		const image = event.currentTarget as HTMLImageElement;
		const aspect = image.naturalWidth / image.naturalHeight;
		// Some provider thumbnails are wide canvases containing a square cover
		// with baked-in letterboxing. Only the full player opts into this crop.
		cropScale = cropWide && aspect > 1.2 ? aspect : 1;
		loaded = true;
	}
</script>

<div class="art" class:round style:--h={hue(seed || id || alt)}>
	{#if src && !failed}
		<img
			{src}
			{alt}
			loading="lazy"
			decoding="async"
			class:loaded
			class:crop-wide={cropWide && cropScale > 1}
			style:--crop-scale={cropScale}
			onload={handleLoad}
			onerror={() => (failed = true)}
		/>
	{/if}
	
	<!-- TỐI ƯU 2: Giữ placeholder hiển thị bên dưới mượt mà, loại bỏ điều kiện thừa -->
	{#if !src || failed || !loaded}
		<div class="placeholder">
			<Icon name={icon} size={Math.max(20, Math.min(64, Math.round(size / 4)))} />
		</div>
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
		/* Isolation giúp đóng gói layer vẽ của ảnh bìa, không gây re-paint ra bên ngoài */
		isolation: isolate;
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
		z-index: 1;
		transition: opacity 0.2s ease;
	}
	img.loaded {
		opacity: 1;
	}
	img.crop-wide {
		transform: scale(var(--crop-scale));
	}
	.placeholder {
		position: absolute;
		inset: 0;
		z-index: 0;
		display: grid;
		place-items: center;
		color: hsl(var(--h) 20% 60% / 0.9);
		background: linear-gradient(145deg, hsl(var(--h) 16% var(--ph-l1, 20%)), hsl(var(--h) 12% var(--ph-l2, 12%)));
	}
</style>
