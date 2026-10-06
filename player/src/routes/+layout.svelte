<script lang="ts">
	import { afterNavigate, beforeNavigate } from "$app/navigation";
	import { page } from "$app/state";
	import { onMount, type Snippet } from "svelte";
	import "../app.css";
	import MiniPlayer from "$lib/components/MiniPlayer.svelte";
	import NowPlaying from "$lib/components/NowPlaying.svelte";
	import Overlays from "$lib/components/Overlays.svelte";
	import PlayerBar from "$lib/components/PlayerBar.svelte";
	import Sidebar from "$lib/components/Sidebar.svelte";
	import TabBar from "$lib/components/TabBar.svelte";
	import { getPlayer } from "$lib/player.svelte";
	import { pageIn, pageOut, type PageMotion } from "$lib/motion";
	import { auth } from "$lib/session.svelte";
	import { ui } from "$lib/ui.svelte";
	import Login from "$lib/views/Login.svelte";

	let { children }: { children: Snippet } = $props();

	let main: HTMLElement | undefined = $state();
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
	beforeNavigate((navigation) => {
		const scroll = main?.scrollTop ?? 0;
		const height = main?.clientHeight;
		if (!matchMedia("(max-width: 899px)").matches) {
			nav.motion = { kind: "rise", scroll, height };
			return;
		}
		const back = navigation.type === "popstate" && (navigation.delta ?? 0) < 0;
		const toTab = TAB_ROOTS.has(navigation.to?.route.id ?? "");
		nav.motion = { kind: back ? "pop" : toTab ? "tab" : "push", scroll, height };
	});

	// <main> is the scroll container, so SvelteKit's window scroll handling doesn't apply.
	// Going back restores where the page was; anything else starts at the top.
	const scrollPositions = new Map<string, number>();
	let restoreScroll: ResizeObserver | undefined;
	beforeNavigate(({ from }) => {
		if (from && main) scrollPositions.set(from.url.hash, main.scrollTop);
	});
	afterNavigate(({ from, to, type }) => {
		if (from?.route.id === "/search" && to?.route.id === "/search") return;
		restoreScroll?.disconnect();
		restoreScroll = undefined;
		const target = type === "popstate" ? (scrollPositions.get(to?.url.hash ?? "") ?? 0) : 0;
		if (!main || !target) {
			main?.scrollTo({ top: 0 });
			return;
		}
		// The page may still be filling in from the network, so keep trying as it grows,
		// until the position is reachable or the user scrolls themselves.
		const el = main;
		const view = el.firstElementChild;
		const attempt = () => {
			el.scrollTop = target;
			if (el.scrollTop >= target - 1) stop();
		};
		const stop = () => {
			restoreScroll?.disconnect();
			restoreScroll = undefined;
			el.removeEventListener("wheel", stop);
			el.removeEventListener("touchstart", stop);
		};
		el.addEventListener("wheel", stop, { passive: true, once: true });
		el.addEventListener("touchstart", stop, { passive: true, once: true });
		attempt();
		if (view && el.scrollTop < target - 1) {
			restoreScroll = new ResizeObserver(attempt);
			restoreScroll.observe(view);
			setTimeout(stop, 3000);
		}
	});

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
				<div class="view" in:pageIn={nav.motion} out:pageOut={nav.motion}>
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