<script lang="ts">
	// Album/playlist header: big artwork, title, accent-coloured subtitle, metadata and actions.
	// On phones, passing `songs` switches to the full-bleed Apple Music hero (shuffle · Play ·
	// download over the artwork); desktop always uses the `actions` snippet.
	import type { Snippet } from 'svelte';
	import { getSession } from '../api';
	import { downloadAll } from '../menus';
	import { listOfflineTrackMetadata } from '../offline';
	import { artworkTint } from '../palette';
	import { getPlayer } from '../player.svelte';
	import { router } from '../router.svelte';
	import type { Song } from '../types';
	import Artwork from './Artwork.svelte';
	import Icon from './Icon.svelte';

	let {
		coverArt,
		title,
		subtitle,
		subtitleHref,
		meta,
		description,
		icon = 'album',
		actions,
		songs,
		onmore
	}: {
		coverArt?: string;
		title: string;
		subtitle?: string;
		subtitleHref?: string;
		meta?: string;
		description?: string;
		icon?: string;
		actions: Snippet;
		songs?: Song[];
		onmore?: (e: MouseEvent) => void;
	} = $props();

	const player = getPlayer();
	const hero = $derived(!!songs);

	let tint = $state<string | null>(null);
	$effect(() => {
		const id = coverArt;
		tint = null;
		Promise.resolve(artworkTint(id)).then((t) => id === coverArt && (tint = t?.top ?? null));
	});

	let offline = $state(new Set<string>());
	let downloading = $state(false);
	const allOffline = $derived(!!songs?.length && songs.every((s) => offline.has(s.id)));

	async function refreshOffline() {
		const user = getSession()?.username;
		if (user) offline = new Set((await listOfflineTrackMetadata(user)).map((m) => m.trackId));
	}
	$effect(() => {
		if (hero) refreshOffline();
	});

	async function download() {
		if (!songs?.length || downloading) return;
		downloading = true;
		try {
			await downloadAll(songs);
		} finally {
			downloading = false;
			await refreshOffline();
		}
	}

	function back() {
		if (history.length > 1) history.back();
		else router.go('/');
	}
</script>

<header class="detail" class:hero style:--tint={tint}>
	{#if hero}
		<div class="topbar">
			<button class="glass" aria-label="Back" onclick={back}><Icon name="chevronLeft" size={20} /></button>
			{#if onmore}<button class="glass" aria-label="More options" onclick={onmore}><Icon name="more" size={20} /></button>{/if}
		</div>
	{/if}
	<div class="art"><Artwork id={coverArt} size={600} seed={title} {icon} priority /></div>
	<div class="info">
		<h1>{title}</h1>
		{#if subtitle}
			{#if subtitleHref}<a class="subtitle" href={subtitleHref}>{subtitle}</a>{:else}<span class="subtitle">{subtitle}</span>{/if}
		{/if}
		{#if meta}<span class="meta">{meta}</span>{/if}
		{#if hero && songs}
			<div class="hero-actions">
				<button
					class="glass"
					aria-label="Shuffle"
					disabled={!songs.length}
					onclick={() => player.playList(songs, 0, { shuffle: true })}><Icon name="shuffle" size={18} /></button
				>
				<button class="play" disabled={!songs.length} onclick={() => player.playList(songs)}>
					<Icon name="play" size={16} />Play
				</button>
				<button
					class="glass"
					class:busy={downloading}
					aria-label={allOffline ? 'Downloaded' : 'Download'}
					disabled={!songs.length}
					onclick={download}><Icon name={allOffline ? 'check' : 'download'} size={18} /></button
				>
			</div>
		{/if}
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
		.hero {
			--hero-bg: var(--tint, #2c2c2e);
			position: relative;
			gap: 0;
			/* The tint fades out inside this bottom padding, below the last line of text. */
			padding: 0 0 32px;
			/* Up under the page's safe-area padding so the art starts at the very top. */
			margin-top: calc(-1 * max(16px, env(safe-area-inset-top)));
			margin-bottom: 8px;
			background: linear-gradient(to bottom, var(--hero-bg) calc(100% - 32px), transparent);
			transition: background-color 0.4s ease;
		}
		.hero .art {
			position: relative;
			width: 100%;
			animation: none;
			--art-radius: 0;
			--art-shadow: none;
		}
		.hero .art::after {
			content: '';
			position: absolute;
			inset: 0;
			background: linear-gradient(to bottom, transparent 45%, var(--hero-bg));
			pointer-events: none;
		}
		.hero .info {
			position: relative;
			z-index: 1;
			margin-top: -100px;
			padding: 0 var(--gutter);
			gap: 2px;
			color: #fff;
		}
		.hero h1 {
			font-size: 24px;
			text-shadow: 0 1px 12px rgb(0 0 0 / 0.25);
		}
		.hero .subtitle {
			font-size: 20px;
			color: rgb(255 255 255 / 0.92);
		}
		.hero .meta {
			font-size: 12px;
			color: rgb(255 255 255 / 0.7);
		}
		.hero .desc {
			margin-top: 14px;
			font-size: 14px;
			color: rgb(255 255 255 / 0.8);
			text-align: left;
			align-self: stretch;
		}
		.hero .actions {
			display: none;
		}
		.topbar {
			position: absolute;
			z-index: 2;
			top: max(12px, env(safe-area-inset-top));
			left: 16px;
			right: 16px;
			display: flex;
			justify-content: space-between;
		}
		.hero-actions {
			display: flex;
			align-items: center;
			justify-content: center;
			gap: 18px;
			margin-top: 14px;
		}
		.glass {
			width: 40px;
			height: 40px;
			border-radius: 50%;
			display: grid;
			place-items: center;
			color: #fff;
			background: rgba(255, 255, 255, 0.22);
			box-shadow: inset 0 0 0 0.5px rgb(255 255 255 / 0.22);
			transition: background-color 0.15s ease, transform 0.15s ease;
		}
		/* Over the artwork: a plain dark scrim keeps the icon readable on any image. */
		.topbar .glass {
			background: rgb(0 0 0 / 0.32);
		}
		.glass:active,
		.play:active {
			transform: scale(0.94);
		}
		.glass.busy {
			animation: pulse 1.1s ease-in-out infinite;
		}
		@keyframes pulse {
			50% {
				opacity: 0.45;
			}
		}
		.play {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			gap: 6px;
			height: 44px;
			min-width: 150px;
			padding: 0 28px;
			border-radius: 22px;
			font-size: 17px;
			font-weight: 600;
			color: #000;
			background: #fff;
			transition: transform 0.15s ease;
		}
		.glass:disabled,
		.play:disabled {
			opacity: 0.5;
		}
	}
	@media (min-width: 700px) {
		.topbar,
		.hero-actions {
			display: none;
		}
	}
</style>
