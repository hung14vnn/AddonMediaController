<script lang="ts">
	import { afterNavigate } from "$app/navigation";
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
	import { pageIn } from "$lib/motion";
	import { auth } from "$lib/session.svelte";
	import { ui } from "$lib/ui.svelte";
	import Login from "$lib/views/Login.svelte";

	let { children }: { children: Snippet } = $props();

	let main: HTMLElement | undefined = $state();

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

	// <main> is the scroll container, so SvelteKit's window scroll handling doesn't apply.
	afterNavigate(({ from, to }) => {
		if (from?.route.id === "/search" && to?.route.id === "/search") return;
		main?.scrollTo({ top: 0 });
	});

	onMount(() => {
		const onPopState = () => {
			if (ui.nowPlaying) ui.closeNowPlaying(true);
		};
		addEventListener("popstate", onPopState);

		if ("serviceWorker" in navigator && import.meta.env.PROD) {
			navigator.serviceWorker
				.register("./service-worker.js")
				.catch(() => {
					/* offline support is optional */
				});
		}

		return () => removeEventListener("popstate", onPopState);
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
				<div class="view" in:pageIn>
					{@render children()}
				</div>
			{/key}
		</main>
		<div class="dock">
			<MiniPlayer />
			<TabBar />
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
		overflow-y: auto;
		overflow-x: hidden;
		min-height: 0;
		scrollbar-gutter: stable;
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
			padding-bottom: calc(64px + env(safe-area-inset-bottom));
		}
		.has-mini main {
			padding-bottom: calc(128px + env(safe-area-inset-bottom));
		}
		.dock {
			display: block;
			position: fixed;
			left: 0;
			right: 0;
			bottom: 0;
			z-index: 10;
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
