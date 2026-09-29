<script lang="ts">
	// Full-screen player modelled on iOS 18 Music: artwork-tinted gradient backdrop,
	// large art near the top that shrinks while paused, and a three-button footer
	// (lyrics · output device · queue). Lyrics/queue sit beside the art on desktop
	// and replace it on phones.
	import { tick } from 'svelte';
	import { slide } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { time } from '../format';
	import { songMenu } from '../menus';
	import { artSwap, fadeOnly, pop, sheet, textSwap } from '../motion';
	import { artworkTint, softArt, type Tint } from '../palette';
	import { getPlayer } from '../player.svelte';
	import { router } from '../router.svelte';
	import { ui } from '../ui.svelte';
	import Artwork from './Artwork.svelte';
	import ArtistLinks from './ArtistLinks.svelte';
	import Icon from './Icon.svelte';
	import Lyrics from './Lyrics.svelte';
	import Queue from './Queue.svelte';
	import Slider from './Slider.svelte';

	const player = getPlayer();
	const song = $derived(player.current);
	const backdrop = $derived(song?.coverArt);
	let scrub = $state<number | null>(null);
	const shownTime = $derived(scrub ?? player.currentTime);

	// TỐI ƯU 1: Làm tròn giây để tránh format chuỗi thời gian liên tục ở từng millisecond
	const formattedCurrentTime = $derived(time(Math.floor(shownTime)));
	const formattedRemainingTime = $derived(
		time(Math.max(0, Math.floor((player.duration || 0) - shownTime)))
	);

	let tint: Tint | null = $state(null);

	$effect(() => {
		const art = song?.coverArt;
		let cancelled = false;
		artworkTint(art).then((t) => {
			if (!cancelled) tint = t;
		});
		return () => (cancelled = true);
	});

	const LOSSLESS = new Set(['flac', 'alac', 'wav', 'aiff', 'aif', 'ape', 'wv']);
	const quality = $derived.by(() => {
		const s = song?.suffix?.toLowerCase();
		if (!s) return '';
		if (LOSSLESS.has(s)) return 'Lossless';
		return song?.bitRate ? `${s.toUpperCase()} · ${song.bitRate} kbps` : s.toUpperCase();
	});

	const outputLabel = $derived(
		player.castState === 'connected' ? 'Casting' : player.castState === 'connecting' ? 'Connecting…' : 'This Device'
	);

	async function pickOutput() {
		if (!(await player.pickOutput())) ui.showToast('No other playback devices found');
	}

	// Track the mobile breakpoint (matches the 900px CSS media query) so JS can
	// decide which transitions to run for the art <-> compact-bar morph and the
	// panel's push-down-the-controls behaviour.
	let isMobile = $state(false);
	type Panel = 'lyrics' | 'queue';
	let mobilePanel = $state<Panel | null>(null);
	let mobilePanelMounted = $state(false);
	let mobilePanelLayoutOpen = $state(false);
	let controlsEl: HTMLDivElement | null = $state(null);

	$effect(() => {
		const mq = window.matchMedia('(max-width: 899px)');
		const update = () => (isMobile = mq.matches);
		update();
		mq.addEventListener('change', update);
		return () => mq.removeEventListener('change', update);
	});

	$effect(() => {
		if (!isMobile) {
			mobilePanelMounted = false;
			mobilePanelLayoutOpen = false;
			mobilePanel = null;
			return;
		}

		if (ui.panel) {
			mobilePanel = ui.panel;
			mobilePanelMounted = true;
			mobilePanelLayoutOpen = true;
		} else if (mobilePanelMounted) {
			mobilePanelMounted = false;
		}
	});

	function toggleMobilePanel(panel: Panel) {
		if (!isMobile) {
			ui.togglePanel(panel);
			return;
		}

		if (ui.panel === panel) {
			// Start the panel outro, but keep the layout in its open state until
			// the outro is completely finished so the controls do not jump.
			mobilePanelMounted = false;
			ui.togglePanel(panel);
			return;
		}

		mobilePanel = panel;
		mobilePanelMounted = true;
		mobilePanelLayoutOpen = true;
		ui.togglePanel(panel);
	}

	function captureControlRows() {
		if (!controlsEl) return new Map<string, DOMRect>();

		return new Map(
			Array.from(controlsEl.querySelectorAll<HTMLElement>('[data-flip-row]')).map((el) => [
				el.dataset.flipRow!,
				el.getBoundingClientRect()
			])
		);
	}

	function playControlFlip(first: Map<string, DOMRect>) {
		if (!controlsEl || !first.size) return;

		const duration = 320;
		const easing = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
		const rows = Array.from(controlsEl.querySelectorAll<HTMLElement>('[data-flip-row]'));

		for (const el of rows) {
			const id = el.dataset.flipRow;
			const before = id ? first.get(id) : undefined;
			if (!before) continue;

			const after = el.getBoundingClientRect();
			const dx = before.left - after.left;
			const dy = before.top - after.top;
			if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;

			el.animate(
				[
					{ transform: `translate3d(${dx}px, ${dy}px, 0)` },
					{ transform: 'translate3d(0, 0, 0)' }
				],
				{ duration, easing, fill: 'none' }
			);
		}
	}

	async function onMobilePanelOutroEnd() {
		// Capture while the compact/panel layout is still active. Then let Svelte
		// commit the final layout and animate every row that moved.
		const first = captureControlRows();
		mobilePanel = null;
		mobilePanelLayoutOpen = false;
		await tick();
		requestAnimationFrame(() => playControlFlip(first));
	}

	// Swipe-down-to-dismiss from anywhere in the Now Playing screen.
	let startY = 0;
	let dragY = $state(0);
	let dismissGesture = false;

	function onTouchStart(e: TouchEvent) {
		// Queue/Lyrics own their touch gestures. Do not let a scroll that bubbles
		// from the panel move or dismiss the Now Playing sheet.
		dismissGesture = !(e.target instanceof Element && e.target.closest('.panel'));
		if (dismissGesture) startY = e.touches[0].clientY;
	}

	function onTouchMove(e: TouchEvent) {
		if (dismissGesture) dragY = Math.max(0, e.touches[0].clientY - startY);
	}

	function onTouchEnd() {
		if (dismissGesture) dragY > 110 ? close() : (dragY = 0);
		dismissGesture = false;
	}

	function close() {
		ui.nowPlaying = false;
	}

	function go(path: string) {
		close();
		router.go(path);
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') close();
	}
</script>

<svelte:window onkeydown={onKey} />

<div
	transition:sheet={{ offset: dragY }}
	class="np"
	class:tinted={!!tint}
	style:transform={dragY ? `translateY(${dragY}px)` : undefined}
	style:transition={dragY && ui.nowPlaying ? 'none' : undefined}
	ontouchstart={onTouchStart}
	ontouchmove={onTouchMove}
	ontouchend={onTouchEnd}
	ontouchcancel={onTouchEnd}
	role="dialog"
	tabindex="-1"
	aria-modal="true"
	aria-label="Now Playing"
>
	<div class="backdrop" aria-hidden="true">
		{#if tint}
			{#key tint}
				<div
					class="tint"
					style:--top={tint.top}
					style:--bottom={tint.bottom}
					in:fadeOnly={{ duration: 900 }}
					out:fadeOnly={{ duration: 900 }}
				></div>
			{/key}
		{/if}
		{#if backdrop}
			{#key backdrop}<canvas use:softArt={backdrop} in:fadeOnly={{ duration: 900 }} out:fadeOnly={{ duration: 900 }}></canvas>{/key}
		{/if}
	</div>

	<div
		class="grab"
		role="presentation"
	>
		<button class="dismiss" aria-label="Close Now Playing" onclick={close}>
			<span class="pill"></span>
			<Icon name="chevronDown" size={26} />
		</button>
	</div>

	{#if song}
		{#snippet panelBody(panel: Panel)}
			{#key panel}
				<div
					class="panel-view"
					in:textSwap={{ dx: 40, duration: 320 }}
					out:textSwap={{ dx: -40, duration: 240 }}
				>
					{#if panel === 'lyrics'}<Lyrics />{:else}<Queue />{/if}
				</div>
			{/key}
		{/snippet}

		<div class="layout" class:mobile-panel={isMobile && mobilePanelLayoutOpen}>
			<div class="main" class:panel-shift={!isMobile && !!ui.panel}>
				<div class="art-row" class:mini={isMobile && mobilePanelLayoutOpen}>
					<div class="art-wrap">
						<div class="art" class:paused={!player.playing}>
							{#key song.id}
								<div in:artSwap>
									<Artwork
										id={song.coverArt}
										size={600}
										seed={song.album ?? song.title}
										cropWide
									/>
								</div>
							{/key}
						</div>
					</div>
					<div class="meta" inert={!(isMobile && mobilePanelLayoutOpen) ? true : undefined}>
						<span class="c-title ellipsis">{song.title}</span>
						<ArtistLinks class="c-artist ellipsis" item={song} forceName={true} onclick={close} />
					</div>
					<button
						class="round meta-btn"
						inert={!(isMobile && mobilePanelLayoutOpen) ? true : undefined}
						aria-label="Favorite"
						onclick={() => ui.toggleLove('song', song)}
					>
						<Icon name={ui.isLoved(song) ? 'starFill' : 'star'} size={16} />
					</button>
					<button
						class="round meta-btn"
						inert={!(isMobile && mobilePanelLayoutOpen) ? true : undefined}
						aria-label="More options"
						onclick={(e) => ui.openMenu(e, songMenu(song))}
					>
						<Icon name="more" size={17} />
					</button>
				</div>

				{#if isMobile && mobilePanelMounted && mobilePanel}
					<div
						class="panel panel-mobile"
						in:slide={{ duration: 420, easing: cubicOut }}
						out:slide={{ duration: 300, easing: cubicOut }}
						onoutroend={onMobilePanelOutroEnd}
					>
						{@render panelBody(mobilePanel)}
					</div>
				{/if}

				<div
					class="controls"
					class:panel-open={isMobile && mobilePanelLayoutOpen}
					bind:this={controlsEl}
				>
					{#if !(isMobile && mobilePanelLayoutOpen)}
						<div class="info" data-flip-row="info">
							{#key song.id}
								<div class="text" in:textSwap>
									<span class="title ellipsis">{song.title}</span>
									<ArtistLinks class="artist ellipsis" item={song} forceName={true} onclick={close} />
								</div>
							{/key}
							<button class="round" class:on={ui.isLoved(song)} aria-label="Favorite" aria-pressed={ui.isLoved(song)} onclick={() => ui.toggleLove('song', song)}>
								{#key ui.isLoved(song)}
									<span class="icon-swap" in:pop={{ from: 0.3, duration: 320 }}>
										<Icon name={ui.isLoved(song) ? 'starFill' : 'star'} size={16} />
									</span>
								{/key}
							</button>
							<button class="round" aria-label="More options" onclick={(e) => ui.openMenu(e, songMenu(song))}>
								<Icon name="more" size={17} />
							</button>
						</div>
					{/if}

					<div class="progress" data-flip-row="progress">
						<Slider value={player.currentTime} max={player.duration} label="Seek" onchange={(v) => player.seek(v)} oninput={(v) => (scrub = v)} />
						<div class="times">
							<span>{formattedCurrentTime}</span>
							<span class="quality">{quality}</span>
							<span class="right">-{formattedRemainingTime}</span>
						</div>
					</div>

					<div class="transport" data-flip-row="transport">
						<button class="skip" aria-label="Previous" onclick={() => player.previous()}><Icon name="previous" size={36} /></button>
						<button class="pp" aria-label={player.playing ? 'Pause' : 'Play'} onclick={() => player.toggle()}>
							{#key player.playing}
								<span class="icon-swap" in:pop={{ from: 0.6, duration: 220 }}>
									<Icon name={player.playing ? 'pause' : 'play'} size={46} />
								</span>
							{/key}
						</button>
						<button class="skip" aria-label="Next" onclick={() => player.next()}><Icon name="next" size={36} /></button>
					</div>

					{#if !(isMobile && mobilePanelLayoutOpen)}
						<div class="volume" data-flip-row="volume">
							<button aria-label={player.muted ? 'Unmute' : 'Mute'} onclick={() => player.toggleMute()}><Icon name="speakerLow" size={15} /></button>
							<Slider value={player.muted ? 0 : player.volume} max={1} step={0.01} label="Volume" onchange={(v) => player.setVolume(v)} oninput={(v) => v !== null && player.setVolume(v)} />
							<Icon name="speaker" size={17} />
						</div>
					{/if}

					<div class="bottom" data-flip-row="bottom">
						<button class="foot" class:on={(isMobile ? mobilePanel === 'lyrics' && mobilePanelLayoutOpen : ui.panel === 'lyrics')} aria-label="Lyrics" aria-pressed={(isMobile ? mobilePanel === 'lyrics' && mobilePanelLayoutOpen : ui.panel === 'lyrics')} onclick={() => toggleMobilePanel('lyrics')}>
							<Icon name="lyrics" size={21} />
						</button>
						<button class="output" class:connected={player.castState === 'connected'} aria-label="Playback device: {outputLabel}" onclick={pickOutput}>
							<Icon name="airplay" size={21} />
							<span>{outputLabel}</span>
						</button>
						<button class="foot" class:on={(isMobile ? mobilePanel === 'queue' && mobilePanelLayoutOpen : ui.panel === 'queue')} aria-label="Playing Next" aria-pressed={(isMobile ? mobilePanel === 'queue' && mobilePanelLayoutOpen : ui.panel === 'queue')} onclick={() => toggleMobilePanel('queue')}>
							<Icon name="queue" size={21} />
						</button>
					</div>
				</div>
			</div>

			{#if !isMobile && ui.panel}
				<div class="panel panel-desktop" in:textSwap={{ dx: 40, duration: 420 }} out:textSwap={{ dx: -40, duration: 280 }}>
					{@render panelBody(ui.panel)}
				</div>
			{/if}
		</div>
	{:else}
		<div class="nothing">
			<Icon name="note" size={56} />
			<p>Not Playing</p>
		</div>
	{/if}
</div>

<style>
	.np {
		position: fixed;
		inset: 0;
		z-index: 50;
		color: #fff;
		background: #3a3a3c;
		overflow: hidden;
		display: flex;
		flex-direction: column;
		transition: transform 0.25s ease;
		--text: #fff;
		--text-2: rgb(255 255 255 / 0.6);
		--slider-fill: rgb(255 255 255 / 0.62);
		--slider-track: rgb(255 255 255 / 0.2);
	}

	/* ---- backdrop --------------------------------------------------------------- */
	.backdrop {
		position: absolute;
		inset: 0;
		z-index: -1;
		background: #3a3a3c;
		contain: strict;
	}
	.tint {
		position: absolute;
		inset: 0;
		z-index: 1;
		background:
			radial-gradient(120% 60% at 50% 0%, color-mix(in srgb, var(--top) 85%, #fff 15%), transparent 70%),
			linear-gradient(180deg, var(--top) 0%, var(--bottom) 100%);
	}
	.backdrop canvas {
		position: absolute;
		inset: -20%;
		width: 140%;
		height: 140%;
		/* Tiny canvas stretched up: the browser's smoothing stands in for blur(). */
		image-rendering: auto;
	}

	/* TỐI ƯU 4: Tắt animation xoay/trôi (drift) trên điện thoại để tiết kiệm pin & hạ nhiệt CPU/GPU */
	@media (min-width: 900px) {
		.backdrop canvas {
			animation: drift 40s ease-in-out infinite alternate;
		}
	}

	.tinted .backdrop canvas {
		z-index: 2;
		opacity: 0.18;
		mix-blend-mode: soft-light;
	}
	.backdrop::after {
		content: '';
		position: absolute;
		inset: 0;
		z-index: 3;
		background: linear-gradient(to bottom, transparent 55%, rgb(0 0 0 / 0.18));
	}

	@keyframes drift {
		0% {
			transform: scale(1) translate3d(0, 0, 0);
		}
		50% {
			transform: scale(1.12) translate3d(3%, -2%, 0);
		}
		100% {
			transform: scale(1.06) translate3d(-3%, 2%, 0);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.backdrop canvas {
			animation: none;
		}
	}

	/* ---- header --------------------------------------------------------------- */
	.grab {
		flex-shrink: 0;
		display: flex;
		justify-content: center;
		padding-top: max(6px, env(safe-area-inset-top));
	}
	.dismiss {
		height: 28px;
		width: 100px;
		display: grid;
		place-items: center;
		color: rgb(255 255 255 / 0.7);
	}
	.dismiss :global(svg) {
		display: none;
	}
	.pill {
		width: 36px;
		height: 5px;
		border-radius: 3px;
		background: rgb(255 255 255 / 0.4);
	}

	/* ---- layout --------------------------------------------------------------- */
	.layout {
		flex: 1;
		min-height: 0;
		display: flex;
		justify-content: center;
		gap: 10vw;
		padding: 0 28px max(12px, env(safe-area-inset-bottom));
	}
	.main {
		width: min(100%, 440px);
		display: flex;
		flex-direction: column;
		min-height: 0;
	}
	.art-row {
		flex: 0 1 auto;
		min-height: 0;
		display: flex;
		align-items: center;
		gap: 12px;
		padding-top: 18px;
		transition:
			padding-top 0.42s cubic-bezier(0.2, 0.8, 0.2, 1),
			gap 0.42s cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	.art-row:not(.mini) {
		gap: 0;
	}
	.art-wrap {
		flex-shrink: 0;
		width: min(100%, 50vh);
		transition: width 0.42s cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	.art {
		width: 100%;
		--art-radius: 10px;
		--art-shadow: 0 18px 44px rgb(0 0 0 / 0.35);
		transition: transform 0.55s cubic-bezier(0.3, 1.35, 0.5, 1);
		transform-origin: center 40%;
	}
	.art.paused {
		transform: scale(0.84);
		--art-shadow: 0 8px 22px rgb(0 0 0 / 0.25);
	}
	/* On mobile, the row also carries the compact title/buttons — collapsed to
	   zero width (and hidden) whenever the art is at full size, since the art
	   itself already claims all the row's width at that point. */
	.meta {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		display: flex;
		flex-direction: column;
		opacity: 0;
		transition: opacity 0.2s ease;
	}
	.meta-btn {
		transition:
			opacity 0.2s ease,
			width 0.42s cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	.art-row:not(.mini) .meta-btn {
		width: 0;
		flex-shrink: 1;
		overflow: hidden;
		opacity: 0;
		pointer-events: none;
	}
	.art-row.mini .meta,
	.art-row.mini .meta-btn {
		opacity: 1;
	}
	.controls {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		justify-content: space-evenly;
		gap: 10px;
		padding-top: 22px;
	}

	/* ---- title row ------------------------------------------------------------ */
	.info {
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.text {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 1px;
	}
	.title {
		font-size: 20px;
		font-weight: 600;
		letter-spacing: -0.01em;
		max-width: 100%;
	}
	:global(.artist) {
		font-size: 19px;
		color: rgb(255 255 255 / 0.58);
		max-width: 100%;
		text-align: left;
	}
	:global(.artist a:hover) {
		text-decoration: underline;
	}
	.round {
		width: 30px;
		height: 30px;
		flex-shrink: 0;
		border-radius: 50%;
		display: grid;
		place-items: center;
		color: #fff;
		background: rgb(255 255 255 / 0.14);
	}
	.round.on {
		background: rgb(255 255 255 / 0.28);
	}

	/* ---- progress ------------------------------------------------------------- */
	.progress :global(.slider) {
		--h: 6px;
	}
	.progress :global(.slider:hover),
	.progress :global(.slider.dragging) {
		--h: 10px;
	}
	.times {
		display: grid;
		grid-template-columns: 1fr auto 1fr;
		align-items: center;
		margin-top: 4px;
		font-size: 11px;
		font-weight: 600;
		color: rgb(255 255 255 / 0.42);
		font-variant-numeric: tabular-nums;
	}
	.times .right {
		text-align: right;
	}
	.quality {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.01em;
	}

	/* ---- transport ------------------------------------------------------------ */
	.transport {
		display: flex;
		justify-content: center;
		align-items: center;
		gap: clamp(28px, 11vw, 56px);
	}
	.transport button {
		display: grid;
		place-items: center;
		width: 68px;
		height: 68px;
		border-radius: 50%;
		color: #fff;
		transition:
			transform 0.14s ease,
			background 0.14s ease;
	}
	.transport button:active {
		transform: scale(0.86);
		background: rgb(255 255 255 / 0.12);
	}

	/* ---- volume --------------------------------------------------------------- */
	.volume {
		display: flex;
		align-items: center;
		gap: 12px;
		color: rgb(255 255 255 / 0.5);
	}
	.volume button {
		display: grid;
		place-items: center;
		color: inherit;
	}
	.volume :global(.slider) {
		--h: 6px;
	}

	/* ---- footer --------------------------------------------------------------- */
	.bottom {
		display: grid;
		grid-template-columns: 1fr auto 1fr;
		align-items: center;
		padding: 2px 10px 0;
	}
	.foot {
		width: 40px;
		height: 34px;
		border-radius: 9px;
		display: grid;
		place-items: center;
		color: rgb(255 255 255 / 0.55);
	}
	.foot:last-child {
		justify-self: end;
	}
	.foot.on {
		color: rgb(0 0 0 / 0.75);
		background: rgb(255 255 255 / 0.85);
	}
	.output {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 3px;
		color: rgb(255 255 255 / 0.55);
		font-size: 11px;
		font-weight: 500;
	}
	.output.connected {
		color: #fff;
	}

	/* ---- side panel (lyrics / queue) ------------------------------------------ */
	.panel {
		width: min(48vw, 780px);
		min-height: 0;
		position: relative;
		flex: 0 1 min(48vw, 780px);
	}
	.panel-view {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
	}
	.nothing {
		flex: 1;
		display: grid;
		place-content: center;
		justify-items: center;
		color: rgb(255 255 255 / 0.5);
		font-size: 20px;
		font-weight: 600;
	}

	/* ---- phones --------------------------------------------------------------- */
	@media (max-width: 899px) {
		.layout {
			flex-direction: column;
			gap: 0;
		}
		.main {
			width: 100%;
			flex: 1;
			display: flex;
			flex-direction: column;
			min-height: 0;
		}
		.mobile-panel {
			padding-top: 10px;
		}
		.art-row.mini {
			padding-top: 0;
		}
		.art-row.mini .art-wrap {
			width: 56px;
		}
		.art-row.mini .art {
			--art-radius: 6px;
		}
		.c-title {
			font-weight: 600;
			font-size: 16px;
		}
		:global(.c-artist) {
			color: rgb(255 255 255 / 0.58);
			font-size: 15px;
		}
		.panel-mobile {
			flex: 1;
			min-height: 0;
			width: auto;
			margin: 0 -12px 10px;
		}
		.controls.panel-open {
			flex: 0 0 auto;
			padding-top: 10px;
			gap: 4px;
		}
	}

	/* ---- desktop -------------------------------------------------------------- */
	@media (min-width: 900px) {
		.layout {
			position: relative;
		}
		.pill {
			display: none;
		}
		.dismiss {
			width: 28px;
			position: absolute;
			left: 20px;
			top: 16px;
			border-radius: 50%;
			background: rgb(255 255 255 / 0.1);
		}
		.dismiss :global(svg) {
			display: block;
		}
		.grab {
			height: 52px;
		}
		@media (display-mode: window-controls-overlay) {
			.grab {
				-webkit-app-region: drag;
			}
			.dismiss {
				-webkit-app-region: no-drag;
			}
		}
		.main {
			width: min(40vw, 440px);
			justify-content: center;
			transition:
				width 0.45s cubic-bezier(0.2, 0.8, 0.2, 1),
				transform 0.45s cubic-bezier(0.2, 0.8, 0.2, 1);
		}
		.main.panel-shift {
			transform: translateX(calc((min(48vw, 780px) + 10vw) / -2));
		}
		.panel-desktop {
			position: absolute;
			top: 0;
			bottom: 0;
			left: calc(50% + (min(40vw, 440px) + 10vw - min(48vw, 780px)) / 2);
			flex: none;
		}
		.controls {
			flex: 0 0 auto;
			gap: 18px;
		}
	}
</style>