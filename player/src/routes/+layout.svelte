<script lang="ts">
	import { beforeNavigate } from "$app/navigation";
	import { page } from "$app/state";
	import { onMount, type Snippet } from "svelte";
	import "../app.css";
	import MiniPlayer from "$lib/components/MiniPlayer.svelte";
	import NowPlaying from "$lib/components/NowPlaying.svelte";
	import Overlays from "$lib/components/Overlays.svelte";
	import PlayerBar from "$lib/components/PlayerBar.svelte";
	import Sidebar from "$lib/components/Sidebar.svelte";
	import TabBar from "$lib/components/TabBar.svelte";
	import { markBackNavigation } from "$lib/api";
	import { getPlayer } from "$lib/player.svelte";
	import { pageIn, pageOut, type PageMotion } from "$lib/motion";
	import { auth } from "$lib/session.svelte";
	import { ui } from "$lib/ui.svelte";
	import Login from "$lib/views/Login.svelte";

	let { children }: { children: Snippet } = $props();

	let main: HTMLElement | undefined = $state();
	/** Set right before navigation moves <main>'s scroll; see the dock's scroll handler. */
	let programmaticScroll = false;
	let compactDock = $state(false);
	let keyboardInset = $state(0);
	const searching = $derived(page.route.id === "/search");

	$effect(() => {
		if (searching) {
			compactDock = false;
			return;
		}
		if (!main) return;
		const el = main;
		let previousTop = el.scrollTop;

		const onscroll = () => {
			const currentTop = el.scrollTop;
			const delta = currentTop - previousTop;
			previousTop = currentTop;
			// A jump made by navigation (to the top, or to a restored offset) isn't the
			// user scrolling: leave the dock as it is.
			if (programmaticScroll) {
				programmaticScroll = false;
				return;
			}

			if (delta < 0) {
				compactDock = false;
			} else if (delta > 0 && currentTop > 96) {
				compactDock = true;
			}
		};
		onscroll();
		el.addEventListener("scroll", onscroll, { passive: true });
		return () => el.removeEventListener("scroll", onscroll);
	});

	// Remount the view per path so each page starts fresh (search keeps its instance).
	const viewKey = $derived(
		page.route.id === "/search" ? "search" : page.url.hash,
	);

	$effect(() => {
		if (auth.signedIn) {
			ui.refreshPlaylists();
			ui.loadMe();
		}
	});

	// Page transition, decided before the navigation happens (see PageMotion):
	// on phones, back = pop, opening a tab's root = tab switch, anything else = push.
	const TAB_ROOTS = new Set(["/", "/browse", "/library", "/search"]);
	// Plain (non-reactive) holder: the transitions read it when they start.
	const nav: { motion: PageMotion } = { motion: { kind: "rise" } };

	// <main> is the scroll container, so SvelteKit's window scroll handling doesn't apply.
	// Going back restores where the page was; anything else starts at the top. The target
	// is decided here, before the navigation, so the arriving page can be scrolled to it
	// as it mounts (see `placeView`), before its first frame is painted.
	const scrollPositions = new Map<string, number>();
	let scrollTarget = 0;
	let restoring = false;

	// Whether the browser animated the current back/forward itself (iOS Safari's edge
	// swipe, Android's predictive back, trackpad swipes). Browsers that say so set
	// `hasUAVisualTransition` (Safari 18+, Chrome 123+); for older ones, a popstate while
	// a touch that began at a screen edge is still down (or was taken over by the browser,
	// which cancels it) counts as one. A tap ends with touchend first, so an in-app back
	// button near the edge still animates.
	let browserAnimatedBack = false;
	let edgeTouchAt = -Infinity;
	const EDGE_PX = 24;
	if (typeof window !== "undefined") {
		addEventListener(
			"touchstart",
			(e) => {
				const x = e.touches[0]?.clientX ?? EDGE_PX;
				edgeTouchAt = x < EDGE_PX || x > innerWidth - EDGE_PX ? performance.now() : -Infinity;
			},
			{ capture: true, passive: true },
		);
		addEventListener("touchend", () => (edgeTouchAt = -Infinity), { capture: true, passive: true });
		// Capture phase: runs before SvelteKit's own popstate listener calls beforeNavigate.
		addEventListener(
			"popstate",
			(e) => {
				browserAnimatedBack =
					(e as PopStateEvent & { hasUAVisualTransition?: boolean }).hasUAVisualTransition === true ||
					performance.now() - edgeTouchAt < 1500;
				edgeTouchAt = -Infinity;
			},
			{ capture: true },
		);
		// Prevent default browser context menu on images in the player
		addEventListener("contextmenu", (e) => {
			const target = e.target as HTMLElement | null;
			if (target && (target.tagName === "IMG" || target.closest("img, .art, .avatar"))) {
				e.preventDefault();
			}
		});
	}

	beforeNavigate((navigation) => {
		const { from, to, type } = navigation;
		const scroll = main?.scrollTop ?? 0;
		if (from) scrollPositions.set(from.url.hash, scroll);
		restoring = type === "popstate";
		if (restoring) markBackNavigation();
		scrollTarget = restoring ? (scrollPositions.get(to?.url.hash ?? "") ?? 0) : 0;

		const height = main?.clientHeight;
		// The browser already slid the pages under the finger: playing our slide on top
		// would pull the page that just settled back to the side and slide it in again.
		if (restoring && browserAnimatedBack) {
			nav.motion = { kind: "none", scroll, height };
			return;
		}
		if (!matchMedia("(max-width: 899px)").matches) {
			nav.motion = { kind: "rise", scroll, height };
			return;
		}
		const back = type === "popstate" && (navigation.delta ?? 0) < 0;
		const toTab = TAB_ROOTS.has(to?.route.id ?? "");
		nav.motion = { kind: back ? "pop" : toTab ? "tab" : "push", scroll, height };
	});

	/**
	 * Runs as each view mounts, in the same frame it is first painted: cached pages are
	 * already full height then, so the scroll lands before anything is drawn. A page still
	 * loading gets more tries as it grows, until the offset is reachable, the user scrolls,
	 * or 3s pass.
	 */
	function placeView(view: HTMLElement) {
		// Set before the first paint, so the content's reveal animation never starts (app.css).
		if (restoring) view.classList.add("restored");
		const el = main;
		if (!el) return;
		const target = scrollTarget;
		const scrollTo = () => {
			const before = el.scrollTop;
			el.scrollTop = target;
			// Only a real change fires a scroll event to consume.
			if (el.scrollTop !== before) programmaticScroll = true;
		};
		scrollTo();
		if (el.scrollTop >= target - 1) return;

		const observer = new ResizeObserver(() => {
			scrollTo();
			if (el.scrollTop >= target - 1) stop();
		});
		const timer = setTimeout(() => stop(), 3000);
		const stop = () => {
			observer.disconnect();
			clearTimeout(timer);
			el.removeEventListener("wheel", stop);
			el.removeEventListener("touchstart", stop);
		};
		el.addEventListener("wheel", stop, { passive: true, once: true });
		el.addEventListener("touchstart", stop, { passive: true, once: true });
		observer.observe(view);
		return { destroy: stop };
	}

	onMount(() => {
		const viewport = window.visualViewport;
		const updateKeyboardInset = () => {
			if (!viewport) return;
			keyboardInset = Math.max(
				0,
				window.innerHeight - viewport.height - viewport.offsetTop,
			);
		};
		const onPopState = () => {
			if (ui.nowPlaying) ui.closeNowPlaying(true);
		};
		addEventListener("popstate", onPopState);
		updateKeyboardInset();
		viewport?.addEventListener("resize", updateKeyboardInset);
		viewport?.addEventListener("scroll", updateKeyboardInset);

		if ("serviceWorker" in navigator && import.meta.env.PROD) {
			navigator.serviceWorker
				.register("./service-worker.js")
				.catch(() => {
					/* offline support is optional */
				});
		}

		return () => {
			removeEventListener("popstate", onPopState);
			viewport?.removeEventListener("resize", updateKeyboardInset);
			viewport?.removeEventListener("scroll", updateKeyboardInset);
		};
	});

	function onKey(e: KeyboardEvent) {
		const t = e.target as HTMLElement;
		if (t.closest("input, textarea, select, [contenteditable]")) return;
		const player = getPlayer();
		if (e.code === "Space") {
			e.preventDefault();
			player.toggle();
		} else if ((e.metaKey || e.ctrlKey) && e.key === "ArrowRight")
			player.next();
		else if ((e.metaKey || e.ctrlKey) && e.key === "ArrowLeft")
			player.previous();
	}
</script>

<svelte:window onkeydown={auth.signedIn ? onKey : undefined} />

{#if !auth.signedIn}
	<Login onlogin={() => (auth.signedIn = true)} />
{:else}
	{@const player = getPlayer()}
	<div class="app" class:has-mini={!!player.current}>
		<aside class="side"><Sidebar /></aside>
		<div class="bar"><PlayerBar /></div>
		<main bind:this={main}>
			{#key viewKey}
				<div class="view" use:placeView in:pageIn={nav.motion} out:pageOut={nav.motion}>
					{@render children()}
				</div>
			{/key}
		</main>
		<div
			class="dock"
			class:dock-compact={compactDock}
			style={`--keyboard-inset: ${keyboardInset}px`}
		>
			<MiniPlayer {compactDock} />
			<TabBar {compactDock} onexpand={() => (compactDock = false)} />
		</div>
	</div>
	{#if ui.nowPlaying}<NowPlaying />{/if}
	<Overlays />
{/if}

<style>
	.app {
		height: 100%;
		display: grid;
		grid-template-columns: var(--sidebar-w) minmax(0, 1fr);
		grid-template-rows: var(--bar-h) minmax(0, 1fr);
		grid-template-areas:
			"side bar"
			"side main";
	}
	.side {
		grid-area: side;
		min-height: 0;
	}
	.bar {
		grid-area: bar;
		z-index: 5;
	}
	main {
		grid-area: main;
		position: relative; /* the leaving page is pinned inside it while sliding out */
		overflow-y: auto;
		overflow-x: hidden;
		min-height: 0;
		scrollbar-gutter: stable;
	}
	/* At least a screen tall, so a page sliding in (opaque while it slides)
	   covers the one underneath even while it only shows a spinner. */
	.view {
		position: relative;
		z-index: 1; /* see lift() in motion.ts: pushed-away page 0, popped page 2 */
		min-height: 100%;
		/* Contain children's margins: a loading page is just a spinner with a 40px
		   top margin, which would otherwise collapse through and push the whole
		   (opaque, sliding) page box down, leaving the old page showing above it. */
		display: flow-root;
	}
	.dock {
		display: none;
	}

	@media (max-width: 899px) {
		.app {
			display: block;
		}
		.side,
		.bar {
			display: none;
		}
		main {
			height: 100%;
			padding-bottom: 0;
		}
		.dock {
			/* biến dùng chung cho MiniPlayer và TabBar */
			--ease: cubic-bezier(0.32, 0.72, 0, 1);
			--dur: 0.5s;
			--pad: max(6px, env(safe-area-inset-bottom));
			--tab-h: 58px;
			--side: 12px;
			--btn: 48px;
			--gap: 8px;
			--row-b: calc(var(--pad) + (var(--tab-h) - var(--btn)) / 2);

			display: block; /* không đổi display khi compact nữa */
			position: fixed;
			left: 0;
			right: 0;
			bottom: var(--keyboard-inset, 0px);
			z-index: 10;
			height: calc(var(--pad) + var(--tab-h) + var(--gap) + 56px);
			pointer-events: none;
		}
		.dock > :global(*) {
			pointer-events: auto;
		}
		:global(:root) {
			--toast-offset: 140px;
		}
	}
</style>