<script lang="ts">
	// Full-screen player modelled on iOS 18 Music: artwork-tinted gradient backdrop,
	// large art near the top that shrinks while paused, and a three-button footer
	// (lyrics · output device · queue). Lyrics/queue sit beside the art on desktop
	// and replace it on phones.
	import { tick } from "svelte";
	import { cubicOut } from "svelte/easing";
	import { time } from "../format";
	import { songMenu } from "../menus";
	import type { TransitionConfig } from "svelte/transition";
	import { artSwap, fadeOnly, pop, sheet, textSwap } from "../motion";
	import { artworkTint, type Tint } from "../palette";
	import { getPlayer } from "../player.svelte";
	import { router } from "../router.svelte";
	import { sleepTimer } from "../sleepTimer.svelte";
	import { ui } from "../ui.svelte";
	import Artwork from "./Artwork.svelte";
	import ArtistLinks from "./ArtistLinks.svelte";
	import Icon from "./Icon.svelte";
	import Lyrics from "./Lyrics.svelte";
	import Queue from "./Queue.svelte";
	import Slider from "./Slider.svelte";

	const player = getPlayer();
	const song = $derived(player.current);
	let scrub = $state<number | null>(null);
	const shownTime = $derived(scrub ?? player.currentTime);
	// Whole seconds: the bar moves ~1px/s, so repainting on every timeupdate (~4/s) is wasted.
	const progressTime = $derived(Math.floor(player.currentTime));

	// Round to whole seconds so the time strings are not re-formatted every millisecond.
	const formattedCurrentTime = $derived(time(Math.floor(shownTime)));
	const formattedRemainingTime = $derived(
		time(Math.max(0, Math.floor((player.duration || 0) - shownTime))),
	);

	let tint: Tint | null = $state(null);
	let npHeight = $state(0);
	let controlsVisible = $state(true);
	let controlsTimer: ReturnType<typeof setTimeout> | undefined;
	let wakeLock: WakeLockSentinel | null = null;

	$effect(() => {
		const art = song?.coverArt;
		let cancelled = false;
		artworkTint(art).then((t) => {
			if (!cancelled) tint = t;
		});
		return () => (cancelled = true);
	});

	const LOSSLESS = new Set([
		"flac",
		"alac",
		"wav",
		"aiff",
		"aif",
		"ape",
		"wv",
	]);
	const quality = $derived.by(() => {
		const s = song?.suffix?.toLowerCase();
		if (!s) return "";
		if (LOSSLESS.has(s)) return "Lossless";
		return song?.bitRate
			? `${s.toUpperCase()} · ${song.bitRate} kbps`
			: s.toUpperCase();
	});

	const outputLabel = $derived(
		player.castStalled
			? "Not responding"
			: player.castState === "connected"
				? "Casting"
				: player.castState === "connecting"
					? "Connecting…"
					: "This Device",
	);

	function showControls() {
		controlsVisible = true;
		if (!isMobile || ui.panel !== "lyrics" || !player.playing) return;
		clearTimeout(controlsTimer);
		controlsTimer = setTimeout(() => (controlsVisible = false), 5000);
	}

	function onPointerDown(e: PointerEvent) {
		if (
			e.target instanceof Element &&
			e.target.closest(".panel, .show-controls")
		)
			return;
		showControls();
	}

	async function releaseWakeLock() {
		if (!wakeLock) return;
		await wakeLock.release();
		wakeLock = null;
	}

	async function requestWakeLock() {
		const wakeLockApi = (
			navigator as Navigator & {
				wakeLock?: { request(type: "screen"): Promise<WakeLockSentinel> };
			}
		).wakeLock;
		if (!wakeLockApi || wakeLock) return;
		try {
			wakeLock = await wakeLockApi.request("screen");
		} catch {
			// Screen wake lock is optional and may be denied by the browser.
		}
	}

	$effect(() => {
		if (ui.panel !== "lyrics") {
			clearTimeout(controlsTimer);
			controlsVisible = true;
			void releaseWakeLock();
			return;
		}

		showControls();
		// Keep the screen on only while music is actually playing: a paused song
		// with lyrics open should let the display sleep.
		if (!player.playing) {
			void releaseWakeLock();
			return;
		}
		const onVisibilityChange = () => {
			if (document.visibilityState === "visible") void requestWakeLock();
		};
		document.addEventListener("visibilitychange", onVisibilityChange);
		void requestWakeLock();

		return () => {
			clearTimeout(controlsTimer);
			document.removeEventListener("visibilitychange", onVisibilityChange);
			void releaseWakeLock();
		};
	});

	$effect(() => {
		if (!isMobile || player.playing) {
			if (ui.panel === "lyrics") showControls();
			return;
		}

		clearTimeout(controlsTimer);
		controlsVisible = true;
	});

	// A stuck AirPlay/Cast hand-off keeps the clock running with no sound; say why.
	$effect(() => {
		if (player.castStalled)
			ui.showToast(
				"Playback device isn’t responding — tap the output button to switch back",
			);
	});

	async function pickOutput() {
		if (!(await player.pickOutput()))
			ui.showToast("No other playback devices found");
	}

	// ---- mobile panel + FLIP ---------------------------------------------------
	// Track the mobile breakpoint (matches the 900px CSS media query).
	let isMobile = $state(false);
	type Panel = "lyrics" | "queue";
	// Single source of truth: is a panel open on mobile?
	const mobileOpen = $derived(isMobile && !!ui.panel);

	let mainEl = $state<HTMLDivElement | null>(null);
	let panelEl = $state<HTMLDivElement | null>(null);
	let leaveBox: {
		top: number;
		left: number;
		width: number;
		height: number;
	} | null = null;

	$effect(() => {
		const mq = window.matchMedia("(max-width: 899px)");
		const update = () => (isMobile = mq.matches);
		update();
		mq.addEventListener("change", update);
		return () => mq.removeEventListener("change", update);
	});

	// Panel only uses opacity + transform, never touches layout.
	function panelIn(_node: HTMLElement, { duration = 500 } = {}) {
		return {
			duration,
			easing: cubicOut,
			css: (t: number) =>
				`opacity:${t};transform:translateY(${(1 - t) * 16}px)`,
		};
	}

	// On leave: pull the panel out of the flow (absolute, keeping its old box) so the
	// new layout applies immediately and FLIP can animate the rest.
	function panelOut(node: HTMLElement, { duration = 350 } = {}) {
		if (leaveBox) {
			Object.assign(node.style, {
				position: "absolute",
				top: `${leaveBox.top}px`,
				left: `${leaveBox.left}px`,
				width: `${leaveBox.width}px`,
				height: `${leaveBox.height}px`,
				margin: "0",
				pointerEvents: "none",
			});
		}
		return {
			duration,
			easing: cubicOut,
			css: (t: number) =>
				`opacity:${t};transform:translateY(${(1 - t) * 14}px)`,
		};
	}

	const FLIP_EASING = "cubic-bezier(0.2, 0.8, 0.2, 1)";

	async function flip(mutate: () => void) {
		if (!mainEl) return mutate();

		const els = () =>
			Array.from(mainEl!.querySelectorAll<HTMLElement>("[data-flip]"));

		// FIRST: measure (works even if a previous animation is mid-flight)
		const first = new Map(
			els().map((el) => [el.dataset.flip!, el.getBoundingClientRect()]),
		);
		const m = mainEl.getBoundingClientRect();
		const p = panelEl?.getBoundingClientRect();
		leaveBox = p
			? {
					top: p.top - m.top,
					left: p.left - m.left,
					width: p.width,
					height: p.height,
				}
			: null;

		mutate();
		await tick();
		leaveBox = null;

		// Cancel old animations before measuring LAST so we get the true final position
		const rows = els();
		rows.forEach((el) => el.getAnimations().forEach((a) => a.cancel()));

		for (const el of rows) {
			const before = first.get(el.dataset.flip!);
			if (!before) continue;
			const after = el.getBoundingClientRect();
			const dx = before.left - after.left;
			const dy = before.top - after.top;
			const sx = after.width ? before.width / after.width : 1;
			const sy = after.height ? before.height / after.height : 1;
			if (
				Math.abs(dx) < 0.5 &&
				Math.abs(dy) < 0.5 &&
				Math.abs(sx - 1) < 0.005 &&
				Math.abs(sy - 1) < 0.005
			)
				continue;

			el.animate(
				[
					{
						transform: `translate3d(${dx}px, ${dy}px, 0) scale(${sx}, ${sy})`,
					},
					{ transform: "translate3d(0, 0, 0) scale(1, 1)" },
				],
				{ duration: 550, easing: FLIP_EASING },
			);
		}
	}

	function toggleMobilePanel(panel: Panel) {
		if (!isMobile) return ui.togglePanel(panel);
		flip(() => ui.togglePanel(panel));
	}

	// Swipe-down-to-dismiss from anywhere in the Now Playing screen.
	let startY = 0;
	let dragY = $state(0);
	let dismissGesture = false;

	function onTouchStart(e: TouchEvent) {
		// Queue/Lyrics own their touch gestures. Do not let a scroll that bubbles
		// from the panel move or dismiss the Now Playing sheet.
		dismissGesture = !(
			e.target instanceof Element && e.target.closest(".panel, .slider")
		);
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
		ui.closeNowPlaying();
	}

	const MORPH_EASE = "cubic-bezier(0.3, 0.7, 0.2, 1)";
	// Title/artist are not in this list: they fly from the mini player instead.
	const MORPH_FADE =
		".grab, .info .round, .progress, .transport, .volume, .bottom, .panel, .nothing, .art-row.mini .meta-btn";
	// Mini player text → its Now Playing counterpart (full layout, or compact
	// row when a panel is open on mobile).
	const MORPH_TEXT = [
		{ from: "[data-np-title]", to: ".info .title, .art-row.mini .c-title" },
		{ from: "[data-np-artist]", to: ".info .artist, .art-row.mini .c-artist" },
	];
	const ART_RADIUS = 10; // matches .art --art-radius
	let morphAnims: Animation[] = [];
	/** Direction the current animations' keyframes were built for. */
	let morphBuiltFor: "in" | "out" = "in";
	/** Direction the sheet is heading now (changes when reversed mid-flight). */
	let morphDir: "in" | "out" = "in";

	// Returns a deferred config: Svelte calls it on every start *and* reversal with
	// the current direction, so open↔close interruptions can be handled here.
	function morph(node: HTMLElement) {
		// (Svelte's types declare no argument, but the runtime passes `{ direction }`.)
		return (opts?: { direction?: "in" | "out" }): TransitionConfig => {
			const dir = opts?.direction === "out" ? "out" : "in";
			const duration = dir === "out" ? 560 : 720;
			morphDir = dir;

			// Reversed mid-flight: turn the running animations around so they continue
			// from where they are and land when Svelte's (shortened) timer does.
			if (morphAnims.some((a) => a.playState === "running")) {
				for (const a of morphAnims) {
					const own = Number(a.effect?.getTiming().duration) || duration;
					a.playbackRate = ((dir === morphBuiltFor ? 1 : -1) * own) / duration;
				}
				return { duration };
			}
			morphAnims.forEach((a) => a.cancel());
			morphAnims = [];
			morphBuiltFor = dir;

			const anchorEl = document.querySelector<HTMLElement>("[data-np-anchor]");
			const anchor = anchorEl?.getBoundingClientRect();
			if (
				!anchor?.width ||
				matchMedia("(prefers-reduced-motion: reduce)").matches
			)
				return sheet(node, { offset: dragY });

			// Frames are written for opening; closing plays them backwards on the same curve.
			const play = (el: Element, frames: Keyframe[]) => {
				const keyframes =
					dir === "out"
						? frames
								.map((f) => ({ ...f, offset: 1 - (f.offset as number) }))
								.reverse()
						: frames;
				const anim = el.animate(keyframes, {
					duration,
					easing: MORPH_EASE,
					fill: "both",
				});
				// Once fully open, hand the elements back to their normal styles.
				// (Fully closed needs nothing: Svelte removes the sheet.)
				anim.onfinish = () => {
					if (morphDir !== "in") return;
					morphAnims.forEach((a) => a.cancel());
					morphAnims = [];
				};
				morphAnims.push(anim);
			};

			// Measured against the sheet's own box so a swipe-down offset is respected.
			const box = node.getBoundingClientRect();
			const inset = [
				anchor.top - box.top,
				box.right - anchor.right,
				box.bottom - anchor.bottom,
				anchor.left - box.left,
			];

			// Artwork: transform the wrapper (origin 0 0) so the inner art lands
			// exactly on the mini player's artwork.
			const wrap = node.querySelector<HTMLElement>(".art-wrap");
			const art = wrap?.querySelector<HTMLElement>(".art");
			const from = document
				.querySelector<HTMLElement>("[data-np-art]")
				?.getBoundingClientRect();
			if (wrap && art && from?.width) {
				wrap.getAnimations().forEach((a) => a.cancel());
				const w = wrap.getBoundingClientRect();
				const b = art.getBoundingClientRect();
				const s = from.width / b.width;
				const dx = from.left - w.left - s * (b.left - w.left);
				const dy = from.top - w.top - s * (b.top - w.top);
				play(wrap, [
					{ offset: 0, transform: `translate3d(${dx}px, ${dy}px, 0) scale(${s})` },
					{ offset: 1, transform: "translate3d(0, 0, 0) scale(1)" },
				]);

				// Counter the scale on the corner radius so the art keeps rounded
				// corners while small (sampled, since scale and radius are inverse).
				const img = art.querySelector(".art");
				if (img) {
					const k = b.width / w.width; // the paused shrink, if any
					const frames: Keyframe[] = [];
					for (let i = 0; i <= 8; i++) {
						const p = i / 8;
						const scale = s + (1 - s) * p;
						const visible = ART_RADIUS + (ART_RADIUS * k - ART_RADIUS) * p;
						frames.push({ offset: p, borderRadius: `${visible / (k * scale)}px` });
					}
					play(img, frames);
				}
			}

			// The sheet starts as a solid copy of the mini pill (same box, radius and
			// colour) and grows to full screen; the tinted backdrop fades in over it.
			const pill = anchorEl ? getComputedStyle(anchorEl).backgroundColor : "";
			// Title and artist: move and scale (by font size) from the mini player's
			// text onto the big text, so they read as the same line.
			// The title's flight, so a line with no visible source (the artist, hidden
			// in the compact dock) can ride along under it instead of being crossed.
			let lead: { dx: number; dy: number; s: number; box: DOMRect } | null = null;
			for (const pair of MORPH_TEXT) {
				const source = document.querySelector<HTMLElement>(pair.from);
				const target = node.querySelector<HTMLElement>(pair.to);
				if (!target) continue;
				const a = source?.getBoundingClientRect();
				const visible =
					source && a?.height && getComputedStyle(source).opacity !== "0";
				const t = target.getBoundingClientRect();
				if (!visible) {
					if (!lead) {
						play(target, [
							{ offset: 0, opacity: 0 },
							{ offset: 0.55, opacity: 0 },
							{ offset: 1, opacity: 1 },
						]);
						continue;
					}
					// Same transform as the title, re-based on this element's origin so
					// both move as one block (d = d_lead + (s - 1)(origin - lead origin)).
					const gx = lead.dx + (lead.s - 1) * (t.left - lead.box.left);
					const gy = lead.dy + (lead.s - 1) * (t.top - lead.box.top);
					play(target, [
						{
							offset: 0,
							opacity: 0,
							transformOrigin: "0 0",
							transform: `translate3d(${gx}px, ${gy}px, 0) scale(${lead.s})`,
						},
						{ offset: 0.3, opacity: 0 },
						{
							offset: 1,
							opacity: 1,
							transformOrigin: "0 0",
							transform: "translate3d(0, 0, 0) scale(1)",
						},
					]);
					continue;
				}
				const s =
					parseFloat(getComputedStyle(source).fontSize) /
					parseFloat(getComputedStyle(target).fontSize);
				const dx = a.left - t.left;
				const dy = a.top + a.height / 2 - (t.top + (t.height * s) / 2);
				lead ??= { dx, dy, s, box: t };
				// Fully visible from the first frame (it sits exactly over the mini text the
				// pill just covered) and recoloured from the mini's colour to its own.
				const fromColor = getComputedStyle(source).color;
				const toColor = getComputedStyle(target).color;
				play(target, [
					{
						offset: 0,
						color: fromColor,
						transformOrigin: "0 0",
						transform: `translate3d(${dx}px, ${dy}px, 0) scale(${s})`,
					},
					{ offset: 0.5, color: toColor },
					{
						offset: 1,
						color: toColor,
						transformOrigin: "0 0",
						transform: "translate3d(0, 0, 0) scale(1)",
					},
				]);
			}

			// Keep the pill's round corners for most of the grow; square up at the end.
			const clip = (p: number, r: number) =>
				`inset(${inset.map((v) => `${v * (1 - p)}px`).join(" ")} round ${r}px)`;
			const radius = anchor.height / 2;
			play(node, [
				{ offset: 0, backgroundColor: pill, clipPath: clip(0, radius) },
				{ offset: 0.8, backgroundColor: pill, clipPath: clip(0.8, radius) },
				{ offset: 1, backgroundColor: pill, clipPath: clip(1, 0) },
			]);

			const backdrop = node.querySelector(".backdrop");
			if (backdrop)
				play(backdrop, [
					{ offset: 0, opacity: 0 },
					{ offset: 0.15, opacity: 0 },
					{ offset: 0.6, opacity: 1 },
					{ offset: 1, opacity: 1 },
				]);
			for (const el of node.querySelectorAll(MORPH_FADE))
				play(el, [
					{ offset: 0, opacity: 0 },
					{ offset: 0.55, opacity: 0 },
					{ offset: 1, opacity: 1 },
				]);

			// Svelte only needs the length (to keep the node mounted while closing).
			return { duration };
		};
	}

	function go(path: string) {
		if (history.state?.nowPlaying) {
			const onPopState = () => {
				removeEventListener("popstate", onPopState);
				router.go(path);
			};
			addEventListener("popstate", onPopState);
			close();
		} else {
			router.go(path);
		}
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === "Escape") close();
	}
</script>

<svelte:window onkeydown={onKey} />

<div
	transition:morph
	class="np"
	class:tinted={!!tint}
	style:--np-top={tint?.top}
	style:--np-bottom={tint?.bottom}
	style:--np-h="{npHeight}px"
	bind:clientHeight={npHeight}
	style:transform={dragY ? `translateY(${dragY}px)` : undefined}
	style:transition={dragY && ui.nowPlaying ? "none" : undefined}
	ontouchstart={onTouchStart}
	ontouchmove={onTouchMove}
	ontouchend={onTouchEnd}
	ontouchcancel={onTouchEnd}
	onpointerdown={onPointerDown}
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
	</div>

	<div class="grab" role="presentation">
		<button class="dismiss" aria-label="Close Now Playing" onclick={close}>
			<span class="pill"></span>
			<Icon name="chevronDown" size={26} />
		</button>
	</div>

	{#if song}
		{#if isMobile && ui.panel === "lyrics" && player.playing && !controlsVisible}
			<button
				class="show-controls"
				aria-label="Show playback controls"
				onclick={showControls}
			>
				<Icon name="chevronDown" size={16} />
			</button>
		{/if}
		{#snippet panelBody(panel: Panel)}
			{#key panel}
				<!-- Any touch or scroll here only brings the controls back; it is not a control itself. -->
				<div
					class="panel-view"
					role="presentation"
					in:textSwap={{ dx: 40, duration: 320 }}
					out:textSwap={{ dx: -40, duration: 240 }}
					onwheel={showControls}
					ontouchmove={showControls}
					onpointerdown={showControls}
				>
					{#if panel === "lyrics"}<Lyrics />{:else}<Queue />{/if}
				</div>
			{/key}
		{/snippet}

		<div class="layout" class:mobile-panel={mobileOpen}>
			<div
				class="main"
				class:panel-shift={!isMobile && !!ui.panel}
				bind:this={mainEl}
			>
				<div class="art-row" class:mini={mobileOpen}>
					<div class="art-wrap" data-flip="art">
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
					<div class="meta" inert={!mobileOpen ? true : undefined}>
						<span class="c-title ellipsis">{song.title}</span>
						<ArtistLinks
							class="c-artist ellipsis"
							item={song}
							onclick={close}
						/>
					</div>
					<button
						class="round meta-btn"
						inert={!mobileOpen ? true : undefined}
						aria-label="Favorite"
						onclick={() => ui.toggleLove("song", song)}
					>
						<Icon
							name={ui.isLoved(song) ? "starFill" : "star"}
							size={16}
						/>
					</button>
					<button
						class="round meta-btn"
						inert={!mobileOpen ? true : undefined}
						aria-label="More options"
						onclick={(e) => ui.openMenu(e, songMenu(song))}
					>
						<Icon name="more" size={17} />
					</button>
				</div>

				{#if mobileOpen && ui.panel}
					<div
						class="panel panel-mobile"
						bind:this={panelEl}
						in:panelIn
						out:panelOut
					>
						{@render panelBody(ui.panel)}
					</div>
				{/if}

				<div
					class="controls"
					class:panel-open={mobileOpen}
					class:overlay={mobileOpen && ui.panel === "lyrics"}
					class:controls-hidden={isMobile && ui.panel === "lyrics" && player.playing && !controlsVisible}
				>
					{#if mobileOpen && ui.panel === "lyrics"}
						<!-- A copy of the screen backdrop, lined up with it, so lyrics passing
						     under the floating controls fade out into the real background. -->
						<div class="overlay-bg" aria-hidden="true">
							<div class="overlay-tint" class:tinted={!!tint}></div>
						</div>
					{/if}
					{#if !mobileOpen}
						<div
							class="info"
							data-flip="info"
							in:fadeOnly={{ duration: 260 }}
						>
							{#key song.id}
								<div class="text" in:textSwap>
									<span class="title ellipsis"
										>{song.title}</span
									>
									<ArtistLinks
										class="artist ellipsis"
										item={song}
										onclick={close}
									/>
								</div>
							{/key}
							<button
								class="round"
								class:on={ui.isLoved(song)}
								aria-label="Favorite"
								aria-pressed={ui.isLoved(song)}
								onclick={() => ui.toggleLove("song", song)}
							>
								{#key ui.isLoved(song)}
									<span
										class="icon-swap"
										in:pop={{ from: 0.3, duration: 320 }}
									>
										<Icon
											name={ui.isLoved(song)
												? "starFill"
												: "star"}
											size={16}
										/>
									</span>
								{/key}
							</button>
							<button
								class="round"
								aria-label="More options"
								onclick={(e) => ui.openMenu(e, songMenu(song))}
							>
								<Icon name="more" size={17} />
							</button>
						</div>
					{/if}

					<div class="progress" data-flip="progress">
						<Slider
							value={progressTime}
							max={player.duration}
							label="Seek"
							onchange={(v) => player.seek(v)}
							oninput={(v) => (scrub = v)}
						/>
						<div class="times">
							<span>{formattedCurrentTime}</span>
							{#if player.muted}
								<!-- iOS ignores volume but honours mute, and the volume row is hidden while a panel is open. -->
								<button
									class="quality muted"
									onclick={() => player.toggleMute()}
									>Muted · Tap to unmute</button
								>
							{:else if sleepTimer.isActive}
								<button
									class="quality active-timer-text"
									onclick={() => (ui.sleepTimerPicker = true)}
								>
									<Icon name="clock" size={11} />
									{sleepTimer.isCountdown
										? sleepTimer.remainingLabel
										: "End of Track"}
								</button>
							{:else}
								<span class="quality">{quality}</span>
							{/if}
							<span class="right">-{formattedRemainingTime}</span>
						</div>
					</div>

					<div class="transport" data-flip="transport">
						<button
							class="skip"
							aria-label="Previous"
							onclick={() => player.previous()}
							><Icon name="previous" size={36} /></button
						>
						<button
							class="pp has-ring"
							aria-label={player.active ? "Pause" : "Play"}
							onclick={() => player.toggle()}
						>
							{#key player.active}
								<span
									class="icon-swap"
									in:pop={{ from: 0.6, duration: 220 }}
								>
									<Icon
										name={player.active ? "pause" : "play"}
										size={46}
									/>
								</span>
							{/key}
							{#if player.buffering}<span class="loading-ring"
								></span>{/if}
						</button>
						<button
							class="skip"
							aria-label="Next"
							onclick={() => player.next()}
							><Icon name="next" size={36} /></button
						>
					</div>

					{#if !mobileOpen}
						<div
							class="volume"
							data-flip="volume"
							in:fadeOnly={{ duration: 260 }}
						>
							<button
								aria-label={player.muted ? "Unmute" : "Mute"}
								onclick={() => player.toggleMute()}
								><Icon name="speakerLow" size={15} /></button
							>
							<Slider
								value={player.muted ? 0 : player.volume}
								max={1}
								step={0.01}
								label="Volume"
								onchange={(v) => player.setVolume(v)}
								oninput={(v) =>
									v !== null && player.setVolume(v)}
							/>
							<Icon name="speaker" size={17} />
						</div>
					{/if}

					<div class="bottom" data-flip="bottom">
						<button
							class="foot"
							class:on={ui.panel === "lyrics"}
							aria-label="Lyrics"
							aria-pressed={ui.panel === "lyrics"}
							onclick={() => toggleMobilePanel("lyrics")}
						>
							<Icon name="lyrics" size={21} />
						</button>
						<button
							class="output"
							class:connected={player.castState === "connected"}
							class:stalled={player.castStalled}
							aria-label="Playback device: {outputLabel}"
							onclick={pickOutput}
						>
							<Icon name="airplay" size={21} />
							<span>{outputLabel}</span>
						</button>
						<button
							class="foot"
							class:on={ui.panel === "queue"}
							aria-label="Playing Next"
							aria-pressed={ui.panel === "queue"}
							onclick={() => toggleMobilePanel("queue")}
						>
							<Icon name="queue" size={21} />
						</button>
					</div>
				</div>
			</div>

			{#if !isMobile && ui.panel}
				<div
					class="panel panel-desktop"
					in:textSwap={{ dx: 40, duration: 420 }}
					out:textSwap={{ dx: -40, duration: 280 }}
				>
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
		background: radial-gradient(
				120% 60% at 50% 0%,
				color-mix(in srgb, var(--top) 85%, #fff 15%),
				transparent 70%
			),
			linear-gradient(180deg, var(--top) 0%, var(--bottom) 100%);
	}
	.backdrop::after {
		content: "";
		position: absolute;
		inset: 0;
		z-index: 3;
		background: linear-gradient(
			to bottom,
			transparent 55%,
			rgb(0 0 0 / 0.18)
		);
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
	.show-controls {
		position: absolute;
		right: max(16px, env(safe-area-inset-right));
		bottom: max(16px, env(safe-area-inset-bottom));
		z-index: 20;
		width: 30px;
		height: 30px;
		display: grid;
		place-items: center;
		border-radius: 50%;
		color: rgb(255 255 255 / 0.8);
		background: rgb(0 0 0 / 0.2);
		animation: show-controls-in 0.35s ease both;
	}
	.show-controls:active {
		transform: scale(0.88);
	}
	.show-controls :global(svg) {
		transform: rotate(180deg);
	}
	@keyframes show-controls-in {
		from {
			opacity: 0;
			transform: translateY(-6px) scale(0.85);
		}
		to {
			opacity: 1;
			transform: translateY(0) scale(1);
		}
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
	/* Layout changes are NOT transitioned in CSS: the FLIP in the script animates
	   [data-flip] elements with transforms instead (compositor only). No permanent
	   will-change: running animations get their own layer anyway, and keeping six
	   (the art is ~7MB at 3x) promoted all the time just wastes GPU memory. */
	[data-flip] {
		transform-origin: 0 0;
	}
	.art-row {
		flex: 0 1 auto;
		min-height: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 12px;
		padding-top: 18px;
	}
	.art-row:not(.mini) {
		gap: 0;
	}
	.art-wrap {
		flex-shrink: 0;
		width: min(100%, 50vh);
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
		transition: opacity 0.2s ease;
	}
	.art-row:not(.mini) .meta,
	.art-row:not(.mini) .meta-btn {
		width: 0;
		flex: 0;
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
		/* Only compositor properties: hiding/showing never re-lays out the page.
		   (Layout changes when a panel opens are animated by the FLIP instead.) */
		transition:
			opacity 0.45s ease,
			transform 0.45s ease;
	}
	.controls.controls-hidden {
		opacity: 0;
		transform: translateY(18px);
		pointer-events: none;
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
		contain: layout paint;
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
	.active-timer-text {
		color: #ffd60a;
	}
	.active-timer-text :global(svg) {
		display: inline-block;
		margin-right: 2px;
		vertical-align: -1.5px;
	}
	.quality.muted {
		color: #ffd60a;
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
	.output.stalled {
		color: #ffd60a;
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
			/* positioned so the leaving panel (absolute) anchors correctly */
			position: relative;
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
			max-height: 260px;
			padding-top: 10px;
			gap: 4px;
		}
		/* With lyrics open the controls float over the bottom of the panel, so
		   auto-hiding them is a pure fade/slide: the lyrics area keeps its size
		   instead of re-laying out (and re-scrolling) every frame. */
		.controls.overlay {
			position: absolute;
			left: 0;
			right: 0;
			bottom: 0;
			z-index: 2;
			margin: 0 -12px;
			padding: 28px 12px 0;
		}
		/* Clipped to the controls' box, with a static top fade (painted once). */
		.overlay-bg {
			position: absolute;
			inset: 0;
			z-index: -1;
			overflow: hidden;
			pointer-events: none;
			-webkit-mask-image: linear-gradient(to bottom, transparent, #000 28px);
			mask-image: linear-gradient(to bottom, transparent, #000 28px);
		}
		/* Full-screen sized and placed where the real backdrop is: the controls
		   sit 16px from the screen edges (28px layout padding − 12px margin) and
		   end at the layout's bottom padding. */
		.overlay-tint {
			position: absolute;
			left: -16px;
			right: -16px;
			bottom: calc(-1 * max(12px, env(safe-area-inset-bottom)));
			height: var(--np-h, 100vh);
			background: #3a3a3c;
		}
		.overlay-tint.tinted {
			background: radial-gradient(
					120% 60% at 50% 0%,
					color-mix(in srgb, var(--np-top) 85%, #fff 15%),
					transparent 70%
				),
				linear-gradient(180deg, var(--np-top) 0%, var(--np-bottom) 100%);
		}
		.overlay-tint::after {
			content: "";
			position: absolute;
			inset: 0;
			background: linear-gradient(
				to bottom,
				transparent 55%,
				rgb(0 0 0 / 0.18)
			);
		}
		.mobile-panel:has(.controls.overlay) .panel-mobile {
			margin-bottom: 0;
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
