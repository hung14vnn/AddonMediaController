<script lang="ts">
	// Floating mini player above the tab bar (iOS 26-style pill).
	import { artistName } from '../format';
	import { getPlayer } from '../player.svelte';
	import { artSwap, fadeOnly, pop, rise, textSwap } from '../motion';
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

	// No setPointerCapture here: with a mouse, capturing on the wrapper makes
	// Chrome/Edge send the click to the wrapper instead of the button under the
	// cursor, so the mini player couldn't be opened. Touch and pen are implicitly
	// captured to the touched element anyway, and pointerup still bubbles up here.
	function onPointerDown(event: PointerEvent) {
		if (!event.isPrimary) return;
		swipeStart = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
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
	}

	function onPointerCancel(event: PointerEvent) {
		if (swipeStart?.pointerId === event.pointerId) swipeStart = null;
	}

	// ---- compact dock FLIP ----------------------------------------------------
	// Compacting changes the layout once, instantly (padding, artist/next taken out
	// of the flow); the moved pieces are then animated from where they were with
	// transforms only, instead of transitioning left/right/width/max-height (which
	// re-lays out the row every frame, on every scroll-direction flip).
	const FLIP_MS = 500;
	const FLIP_EASE = 'cubic-bezier(0.32, 0.72, 0, 1)'; // = the dock's --ease
	let contentEl = $state<HTMLElement>();
	let before: Map<string, DOMRect> | null = null;

	function measure(root: HTMLElement) {
		const box = root.getBoundingClientRect();
		const rects = new Map<string, DOMRect>();
		for (const el of root.querySelectorAll<HTMLElement>('[data-flip]')) {
			const r = el.getBoundingClientRect();
			// Relative to the row, so the dock's own slide doesn't count as movement.
			rects.set(el.dataset.flip!, new DOMRect(r.left - box.left, r.top - box.top, r.width, r.height));
		}
		return rects;
	}

	$effect.pre(() => {
		void compactDock;
		// Before the DOM update: where things are now (mid-animation included).
		if (contentEl) before = measure(contentEl);
	});

	$effect(() => {
		void compactDock;
		const root = contentEl;
		const first = before;
		before = null;
		if (!root || !first || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
		for (const el of root.querySelectorAll<HTMLElement>('[data-flip]')) {
			el.getAnimations().forEach((a) => a.cancel());
		}
		const last = measure(root);
		for (const el of root.querySelectorAll<HTMLElement>('[data-flip]')) {
			const a = first.get(el.dataset.flip!);
			const b = last.get(el.dataset.flip!);
			if (!a || !b) continue;
			// transform-origin is left center (see CSS): left edge and vertical centre
			// stay put under scaling, so those are what we line up.
			const dx = a.left - b.left;
			const dy = a.top + a.height / 2 - (b.top + b.height / 2);
			const k = 'flipScale' in el.dataset && b.width ? a.width / b.width : 1;
			if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(k - 1) < 0.005) continue;
			const end = getComputedStyle(el).transform;
			const rest = end === 'none' ? '' : end;
			el.animate(
				[{ transform: `translate(${dx}px, ${dy}px) scale(${k}) ${rest}` }, { transform: rest || 'none' }],
				{ duration: FLIP_MS, easing: FLIP_EASE }
			);
		}
	});

	function openNowPlaying(event: MouseEvent) {
		if (Date.now() < suppressOpenClickUntil) {
			event.preventDefault();
			return;
		}
		ui.openNowPlaying();
	}

	function artIntro(node: Element, options: { duration?: number }) {
		// `artSwap` writes a scale transform.  In the compact dock the artwork
		// already has a permanent CSS scale, so use an opacity-only swap instead
		// of briefly overriding that scale and snapping back to it.
		return compactDock ? fadeOnly(node, { duration: 160 }) : artSwap(node, options);
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
		<span class="bg" aria-hidden="true" data-np-anchor></span>

		<div class="content" bind:this={contentEl}>
			<button class="open" onclick={openNowPlaying} aria-label="Open Now Playing">
				{#key song.id}
					<span
						class="art"
						data-np-art
						data-flip="art"
						data-flip-scale
						in:artIntro={{ duration: 320 }}
					>
						<Artwork id={song.coverArt} size={64} seed={song.album ?? song.title} />
					</span>
					<span class="meta" data-flip="meta" in:textSwap>
						<span class="title ellipsis" data-np-title>{song.title}</span>
						<span class="artist ellipsis" data-np-artist>{artistName(song)}</span>
					</span>
				{/key}
			</button>
			<button class="ctl has-ring" data-flip="pp" data-np-play aria-label={player.active ? 'Pause' : 'Play'} onclick={() => player.toggle()}>
				{#key player.active}
					<span class="icon-swap" in:pop={{ from: 0.5, duration: 200 }}>
						<Icon name={player.active ? 'pause' : 'play'} size={24} />
					</span>
				{/key}
				{#if player.buffering}<span class="loading-ring"></span>{/if}
			</button>
			<button
				class="ctl next"
				data-np-next
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

	/* The row keeps its full box; compacting narrows the visible part with a
	   clip-path (a cheap repaint of a 56px strip) and moves the contents in with
	   padding, changed instantly and animated by the FLIP in the script. */
	.content {
		--inset-x: calc(var(--btn, 48px) + var(--gap, 8px));
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		gap: 4px;
		box-sizing: border-box;
		padding: 0 8px 0 6px;
		overflow: hidden;
		clip-path: inset(0 round 28px);
		contain: strict;
		transition: clip-path var(--dur, 0.5s) var(--ease, ease);
	}
	.mini.compact .content {
		padding: 0 calc(var(--inset-x) + 8px) 0 calc(var(--inset-x) + 6px);
		clip-path: inset(4px var(--inset-x) round 24px);
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
		margin-left: 6px;
		--art-radius: 10px;
		--art-shadow: 0 2px 8px rgb(0 0 0 / 0.18);
	}
	/* The FLIP lines elements up by their left edge and vertical centre. */
	[data-flip] {
		transform-origin: left center;
	}
	.mini.compact .art {
		transform: scale(0.75);
		margin-left: 4px;
		margin-right: -10px; /* bù chỗ trống do ảnh thu nhỏ */
	}

	.meta {
		position: relative; /* anchors the artist line while it fades out */
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
		transition: opacity calc(var(--dur, 0.5s) * 0.5) var(--ease, ease);
	}
	/* Out of the flow (so the title re-centres in one layout) and faded. */
	.mini.compact .artist {
		position: absolute;
		top: 100%;
		left: 0;
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
			opacity calc(var(--dur, 0.5s) * 0.5) var(--ease, ease),
			transform var(--dur, 0.5s) var(--ease, ease);
	}
	/* Taken out of the flow where it stood; the clip and the fade hide it. */
	.mini.compact .ctl.next {
		position: absolute;
		right: 8px;
		top: 6px;
		opacity: 0;
		transform: scale(0.6);
		pointer-events: none;
	}

	@media (prefers-reduced-motion: reduce) {
		.mini,
		.bg,
		.content,
		.artist,
		.ctl.next {
			transition-duration: 0.01ms;
		}
	}
</style>
