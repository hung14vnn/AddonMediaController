<script lang="ts">
	// Square artwork tile used for albums and playlists, with the Apple Music hover
	// affordances: a play button bottom-left and a "more" button bottom-right.
	import Artwork from './Artwork.svelte';
	import Icon from './Icon.svelte';

	import type { Snippet } from 'svelte';
	let {
		href,
		coverArt,
		title,
		subtitle,
		subtitleHref,
		subtitleSlot,
		explicit = false,
		icon = 'note',
		onplay,
		onmenu
	}: {
		href: string;
		coverArt?: string;
		title: string;
		subtitle?: string;
		subtitleHref?: string;
		subtitleSlot?: Snippet;
		explicit?: boolean;
		icon?: string;
		onplay?: () => void;
		onmenu?: (e: MouseEvent) => void;
	} = $props();
</script>

<div class="card" oncontextmenu={onmenu} role="group">
	<a class="cover" {href} aria-label={title}>
		<Artwork id={coverArt} seed={title} alt="" {icon} />
		<div class="overlay">
			{#if onplay}
				<button
					class="play"
					aria-label="Play {title}"
					onclick={(e) => {
						e.preventDefault();
						e.stopPropagation();
						onplay();
					}}><Icon name="play" size={18} /></button
				>
			{/if}
			{#if onmenu}
				<button
					class="more"
					aria-label="More options"
					onclick={(e) => {
						e.preventDefault();
						onmenu(e);
					}}><Icon name="more" size={18} /></button
				>
			{/if}
		</div>
	</a>
	<div class="meta">
		<a class="title" {href}>
			<span class="clamp">{title}</span>
			{#if explicit}<span class="explicit" aria-label="Explicit">E</span>{/if}
		</a>
		{#if subtitleSlot}
			{@render subtitleSlot()}
		{:else if subtitle}
			{#if subtitleHref}
				<a class="subtitle" href={subtitleHref}>{subtitle}</a>
			{:else}
				<span class="subtitle">{subtitle}</span>
			{/if}
		{/if}
	</div>
</div>

<style>
	.card {
		min-width: 0;
	}
	.cover {
		position: relative;
		display: block;
		border-radius: 8px;
		--art-shadow: 0 0 0 0.5px var(--hairline);
	}
	.cover :global(.art) {
		transition:
			transform 0.35s cubic-bezier(0.2, 0.8, 0.2, 1),
			box-shadow 0.35s ease;
		/* Ép Compositor Layer để animation hover trơn tru 60 FPS */
		will-change: transform;
	}
	@media (hover: hover) {
		.card:hover .cover :global(.art) {
			transform: translateY(-3px);
			box-shadow:
				0 12px 28px rgb(0 0 0 / 0.18),
				0 0 0 0.5px var(--hairline);
		}
		.card:hover .overlay {
			transform: translateY(-3px);
		}
	}
	.overlay {
		position: absolute;
		inset: 0;
		border-radius: 8px;
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		padding: 10px;
		opacity: 0;
		background: linear-gradient(to top, rgb(0 0 0 / 0.38), transparent 55%);
		transition:
			opacity 0.18s ease,
			transform 0.35s cubic-bezier(0.2, 0.8, 0.2, 1);
		will-change: opacity, transform;
	}
	.overlay button {
		transform: translateY(6px);
	}
	.card:hover .overlay button,
	.overlay:focus-within button {
		transform: none;
	}
	@media (hover: hover) {
		.card:hover .overlay,
		.cover:focus-visible .overlay,
		.overlay:focus-within {
			opacity: 1;
		}
	}
	
	/* TỐI ƯU HỆ THỐNG: Bỏ backdrop-filter hoàn toàn cho nút trong Card */
	.overlay button {
		width: 32px;
		height: 32px;
		border-radius: 50%;
		display: grid;
		place-items: center;
		color: #fff;
		/* Sử dụng màu tối có độ trong suốt kết hợp viền hairline mỏng thay vì blur */
		background: rgba(30, 30, 32, 0.75);
		border: 0.5px solid rgba(255, 255, 255, 0.2);
		box-shadow: 0 4px 10px rgba(0, 0, 0, 0.25);
		transition:
			transform 0.15s ease,
			background 0.15s ease,
			border-color 0.15s ease;
	}
	.overlay button:hover {
		background: var(--accent);
		border-color: transparent;
		transform: scale(1.08);
	}
	.overlay .play :global(svg) {
		margin-left: 2px;
	}
	.meta {
		padding-top: 7px;
		display: flex;
		flex-direction: column;
		gap: 1px;
		font-size: 13px;
		line-height: 1.3;
	}
	.title {
		display: flex;
		align-items: baseline;
		gap: 4px;
		font-weight: 500;
		color: var(--text);
		min-width: 0;
	}
	.clamp {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.subtitle {
		color: var(--text-2);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	a.subtitle:hover,
	a.title:hover {
		text-decoration: underline;
	}
</style>