<script lang="ts">
	// Floating mini player above the tab bar (iOS 26-style pill).
	import { artistName } from '../format';
	import { getPlayer } from '../player.svelte';
	import { artSwap, pop, rise, textSwap } from '../motion';
	import { ui } from '../ui.svelte';
	import Artwork from './Artwork.svelte';
	import Icon from './Icon.svelte';

	let { compactDock = false }: { compactDock?: boolean } = $props();
	const player = getPlayer();
	const song = $derived(player.current);
	const SWIPE_THRESHOLD = 48;
	let swipeStart: { x: number; y: number; pointerId: number } | null = null;
	let suppressOpenClickUntil = 0;

	let width = $state(0);
	const scaleX = $derived(width > 0 ? (width - 112) / width : 0.7);

	function onPointerDown(event: PointerEvent) {
		if (!event.isPrimary) return;
		const target = event.currentTarget;
		if (!(target instanceof HTMLElement)) return;
		swipeStart = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
		target.setPointerCapture(event.pointerId);
	}

	function onPointerUp(event: PointerEvent) {
		if (!swipeStart || event.pointerId !== swipeStart.pointerId) return;

		const deltaX = event.clientX - swipeStart.x;
		const deltaY = event.clientY - swipeStart.y;
		const isHorizontalSwipe =
			Math.abs(deltaX) >= SWIPE_THRESHOLD && Math.abs(deltaX) > Math.abs(deltaY);

		if (isHorizontalSwipe) {
			event.preventDefault();
			suppressOpenClickUntil = Date.now() + 500;
			if (deltaX < 0) player.next();
			else player.previous();
		}

		swipeStart = null;
		const target = event.currentTarget;
		if (target instanceof HTMLElement && target.hasPointerCapture(event.pointerId)) {
			target.releasePointerCapture(event.pointerId);
		}
	}

	function onPointerCancel(event: PointerEvent) {
		if (swipeStart?.pointerId === event.pointerId) swipeStart = null;
	}

	function openNowPlaying(event: MouseEvent) {
		if (Date.now() < suppressOpenClickUntil) {
			event.preventDefault();
			return;
		}
		ui.openNowPlaying();
	}
</script>

{#if song}
	<div
		class="mini"
		class:compact={compactDock}
		style:--sx={scaleX}
		bind:clientWidth={width}
		in:rise
		out:rise={{ duration: 220 }}
		role="group"
		onpointerdown={onPointerDown}
		onpointerup={onPointerUp}
		onpointercancel={onPointerCancel}
	>
		<span class="bg" aria-hidden="true"></span>

		<div class="content">
			<button class="open" onclick={openNowPlaying} aria-label="Open Now Playing">
				{#key song.id}
					<span class="art" in:artSwap={{ duration: 320 }}>
						<Artwork id={song.coverArt} size={64} seed={song.album ?? song.title} />
					</span>
					<span class="meta" in:textSwap>
						<span class="title ellipsis">{song.title}</span>
						<span class="artist ellipsis">{artistName(song)}</span>
					</span>
				{/key}
			</button>
			<button class="ctl has-ring" aria-label={player.active ? 'Pause' : 'Play'} onclick={() => player.toggle()}>
				{#key player.active}
					<span class="icon-swap" in:pop={{ from: 0.5, duration: 200 }}>
						<Icon name={player.active ? 'pause' : 'play'} size={24} />
					</span>
				{/key}
				{#if player.buffering}<span class="loading-ring"></span>{/if}
			</button>
			<button
				class="ctl next"
				aria-label="Next"
				aria-hidden={compactDock}
				tabindex={compactDock ? -1 : 0}
				disabled={compactDock}
				onclick={() => player.next()}
			>
				<Icon name="next" size={24} />
			</button>
		</div>
	</div>
{/if}

<style>
	.mini {
		--drop: calc(var(--tab-h, 58px) / 2 + var(--gap, 8px) + 28px);

		position: absolute;
		z-index: 2;
		left: var(--side, 12px);
		right: var(--side, 12px);
		bottom: calc(var(--pad, 6px) + var(--tab-h, 58px) + var(--gap, 8px));
		height: 56px;
		touch-action: pan-y;
		user-select: none;
		will-change: transform;
		transition: transform var(--dur, 0.5s) var(--ease, ease);
	}
	.mini.compact {
		transform: translateY(var(--drop));
	}

	.bg {
		position: absolute;
		inset: 0;
		box-sizing: border-box;
		border-radius: 28px;
		border: 0.5px solid var(--hairline);
		background: var(--chrome-strong, rgba(30, 30, 30, 0.95));
		box-shadow:
			0 6px 24px rgb(0 0 0 / 0.16),
			inset 0 0 0 0.5px var(--hairline);
		will-change: transform;
		transition: transform var(--dur, 0.5s) var(--ease, ease);
	}
	.mini.compact .bg {
		transform: scale(var(--sx, 0.7), 0.857);
	}

	.content {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		gap: 4px;
		box-sizing: border-box;
		padding: 0 8px 0 6px;
		overflow: hidden;
		border-radius: 28px;
		contain: strict;
		transition:
			left var(--dur, 0.5s) var(--ease, ease),
			right var(--dur, 0.5s) var(--ease, ease),
			top var(--dur, 0.5s) var(--ease, ease),
			bottom var(--dur, 0.5s) var(--ease, ease);
	}
	.mini.compact .content {
		left: calc(var(--btn, 48px) + var(--gap, 8px));
		right: calc(var(--btn, 48px) + var(--gap, 8px));
		top: 4px;
		bottom: 4px;
		border-radius: 24px;
	}

	.open {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 12px;
		height: 100%;
		text-align: left;
	}
	.art {
		/* never shrink the artwork to make room for a long title */
		flex: none;
		width: 40px;
		margin-left: 8px;
		--art-radius: 10px;
		--art-shadow: 0 2px 8px rgb(0 0 0 / 0.18);
		transform-origin: left center;
		transition:
			transform var(--dur, 0.5s) var(--ease, ease),
			margin var(--dur, 0.5s) var(--ease, ease);
	}
	.mini.compact .art {
		transform: scale(0.75);
		margin-left: 0;
		margin-right: -10px; /* bù chỗ trống do ảnh thu nhỏ */
	}

	.meta {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 1px;
		line-height: 1.2;
	}
	.title {
		display: block;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 15px;
		font-weight: 500;
	}
	.artist {
		display: block;
		max-width: 100%;
		max-height: 2em;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 12px;
		font-weight: 400;
		color: var(--text-2);
		transition:
			max-height var(--dur, 0.5s) var(--ease, ease),
			opacity calc(var(--dur, 0.5s) * 0.5) var(--ease, ease);
	}
	.mini.compact .artist {
		max-height: 0;
		opacity: 0;
	}

	.ctl {
		flex: 0 0 44px;
		width: 44px;
		height: 44px;
		display: grid;
		place-items: center;
		color: var(--text);
	}
	.ctl.next {
		transition:
			flex-basis var(--dur, 0.5s) var(--ease, ease),
			width var(--dur, 0.5s) var(--ease, ease),
			margin var(--dur, 0.5s) var(--ease, ease),
			opacity calc(var(--dur, 0.5s) * 0.5) var(--ease, ease),
			transform var(--dur, 0.5s) var(--ease, ease);
	}
	.mini.compact .ctl.next {
		flex-basis: 0;
		width: 0;
		margin-left: -4px;
		opacity: 0;
		transform: scale(0.6);
		overflow: hidden;
		pointer-events: none;
	}

	@media (prefers-reduced-motion: reduce) {
		.mini,
		.bg,
		.content,
		.art,
		.artist,
		.ctl.next {
			transition-duration: 0.01ms;
		}
	}
</style>