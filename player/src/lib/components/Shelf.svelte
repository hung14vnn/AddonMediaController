<script lang="ts">
	// Horizontally scrolling row with a header, like Apple Music's shelves.
	import type { Snippet } from 'svelte';
	import Icon from './Icon.svelte';

	let {
		title,
		seeAll,
		size = 'md',
		children
	}: { title: string; seeAll?: string; size?: 'sm' | 'md' | 'lg' | 'artist'; children: Snippet } = $props();

	let scroller: HTMLDivElement | undefined = $state();
	let atStart = $state(true);
	let atEnd = $state(false);

	function update() {
		if (!scroller) return;
		atStart = scroller.scrollLeft < 4;
		atEnd = scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - 4;
	}

	function page(dir: number) {
		scroller?.scrollBy({ left: dir * scroller.clientWidth * 0.9, behavior: 'smooth' });
	}

	$effect(() => {
		if (!scroller) return;
		const ro = new ResizeObserver(update);
		ro.observe(scroller);
		return () => ro.disconnect();
	});
</script>

<section class="shelf">
	<header>
		{#if seeAll}
			<a class="title" href={seeAll}>{title}<Icon name="chevronRight" size={18} /></a>
		{:else}
			<h2 class="title">{title}</h2>
		{/if}
		<div class="nav">
			<button aria-label="Scroll left" disabled={atStart} onclick={() => page(-1)}><Icon name="chevronLeft" size={18} /></button>
			<button aria-label="Scroll right" disabled={atEnd} onclick={() => page(1)}><Icon name="chevronRight" size={18} /></button>
		</div>
	</header>
	<div class="row {size}" bind:this={scroller} onscroll={update}>
		{@render children()}
	</div>
</section>

<style>
	.shelf {
		margin-bottom: 30px;
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0 var(--gutter);
		margin-bottom: 10px;
	}
	.title {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		font-size: 20px;
		font-weight: 700;
		letter-spacing: -0.01em;
		color: var(--text);
		margin: 0;
	}
	a.title :global(svg) {
		color: var(--text-3);
	}
	.nav {
		display: none;
		gap: 6px;
	}
	@media (hover: hover) and (min-width: 700px) {
		.nav {
			display: flex;
		}
	}
	.nav button {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		display: grid;
		place-items: center;
		color: var(--text-2);
		background: var(--fill);
	}
	.nav button:disabled {
		opacity: 0.35;
	}
	.row {
		display: grid;
		grid-auto-flow: column;
		gap: 20px;
		overflow-x: auto;
		overscroll-behavior-x: contain;
		scroll-snap-type: x mandatory;
		scroll-padding-inline: var(--gutter);
		padding: 0 var(--gutter) 6px;
		scrollbar-width: none;
	}
	.row::-webkit-scrollbar {
		display: none;
	}
	.row > :global(*) {
		scroll-snap-align: start;
	}
	.row.sm {
		grid-auto-columns: clamp(120px, 14vw, 160px);
	}
	.row.md {
		grid-auto-columns: clamp(140px, 17vw, 200px);
	}
	.row.lg {
		grid-auto-columns: clamp(220px, 28vw, 320px);
	}
	.row.artist {
		grid-auto-columns: clamp(110px, 13vw, 170px);
	}
	@media (max-width: 699px) {
		.row {
			gap: 12px;
		}
		.row.md,
		.row.sm {
			grid-auto-columns: 42vw;
		}
		.row.lg {
			grid-auto-columns: 64vw;
		}
		.row.artist {
			grid-auto-columns: 32vw;
		}
	}
</style>
