<script lang="ts">
	// Album/playlist header: big artwork, title, accent-coloured subtitle, metadata and actions.
	import type { Snippet } from 'svelte';
	import Artwork from './Artwork.svelte';

	let {
		coverArt,
		title,
		subtitle,
		subtitleHref,
		meta,
		description,
		icon = 'album',
		actions
	}: {
		coverArt?: string;
		title: string;
		subtitle?: string;
		subtitleHref?: string;
		meta?: string;
		description?: string;
		icon?: string;
		actions: Snippet;
	} = $props();
</script>

<header class="detail">
	<div class="art"><Artwork id={coverArt} size={600} seed={title} {icon} /></div>
	<div class="info">
		<h1>{title}</h1>
		{#if subtitle}
			{#if subtitleHref}<a class="subtitle" href={subtitleHref}>{subtitle}</a>{:else}<span class="subtitle">{subtitle}</span>{/if}
		{/if}
		{#if meta}<span class="meta">{meta}</span>{/if}
		{#if description}<p class="desc">{description}</p>{/if}
		<div class="actions">{@render actions()}</div>
	</div>
</header>

<style>
	.detail {
		display: flex;
		align-items: flex-end;
		gap: 30px;
		padding: 0 var(--gutter) 28px;
	}
	.art {
		animation: art-land 0.6s cubic-bezier(0.2, 0.9, 0.3, 1.1) both;
		width: clamp(200px, 22vw, 270px);
		flex-shrink: 0;
		--art-shadow: 0 8px 30px rgb(0 0 0 / 0.16), inset 0 0 0 0.5px var(--hairline);
	}
	@keyframes art-land {
		from {
			opacity: 0;
			transform: scale(0.9) translateY(10px);
		}
	}
	@keyframes text-in {
		from {
			opacity: 0;
			transform: translateY(8px);
		}
	}
	.info > :global(*) {
		animation: text-in 0.5s cubic-bezier(0.2, 0.8, 0.2, 1) both;
	}
	.info > :global(:nth-child(2)) {
		animation-delay: 60ms;
	}
	.info > :global(:nth-child(3)) {
		animation-delay: 110ms;
	}
	.info > :global(:nth-child(n + 4)) {
		animation-delay: 160ms;
	}
	.info {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
	}
	h1 {
		margin: 0;
		font-size: clamp(22px, 2.4vw, 30px);
		font-weight: 700;
		letter-spacing: -0.02em;
		line-height: 1.15;
	}
	.subtitle {
		font-size: clamp(18px, 2vw, 24px);
		color: var(--accent);
		letter-spacing: -0.01em;
	}
	a.subtitle:hover {
		text-decoration: underline;
	}
	.meta {
		font-size: 12px;
		font-weight: 600;
		color: var(--text-2);
		text-transform: uppercase;
		letter-spacing: 0.02em;
	}
	.desc {
		margin: 6px 0 0;
		font-size: 13px;
		color: var(--text-2);
		max-width: 60ch;
		display: -webkit-box;
		-webkit-line-clamp: 3;
		line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.actions {
		margin-top: 16px;
	}
	@media (max-width: 699px) {
		.detail {
			flex-direction: column;
			align-items: center;
			text-align: center;
			gap: 18px;
		}
		.art {
			width: min(70vw, 280px);
		}
		.info {
			align-items: center;
			width: 100%;
		}
		.meta {
			text-transform: none;
			font-weight: 500;
		}
		.actions {
			width: 100%;
		}
	}
</style>
