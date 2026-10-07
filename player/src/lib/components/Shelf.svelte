<script lang="ts">
	// Horizontally scrolling row with a header, like Apple Music's shelves.
	import type { Snippet } from 'svelte';
	import Icon from './Icon.svelte';

	let {
		title,
		subtitle,
		seeAll,
		size = 'md',
		onRefresh,
		children
	}: {
		title: string;
		/** Small line under the title, e.g. why a shelf is recommended. */
		subtitle?: string;
		seeAll?: string;
		size?: 'sm' | 'md' | 'lg' | 'artist';
		onRefresh?: () => void;
		children: Snippet;
	} = $props();

	let scroller = $state<HTMLDivElement | null>(null);
	let atStart = $state(true);
	let atEnd = $state(false);

	let ticking = false;

	// TỐI ƯU 1: Debounce/Throttle bằng requestAnimationFrame để chống Layout Thrashing khi scroll
	function update() {
		if (!scroller || ticking) return;
		ticking = true;

		requestAnimationFrame(() => {
			if (scroller) {
				atStart = scroller.scrollLeft < 4;
				atEnd = scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - 4;
			}
			ticking = false;
		});
	}

	function page(dir: number) {
		if (!scroller) return;
		scroller.scrollBy({ left: dir * scroller.clientWidth * 0.9, behavior: 'smooth' });
	}

	$effect(() => {
		if (!scroller) return;
		update(); // Cập nhật trạng thái nút bấm ngay lần render đầu

		const ro = new ResizeObserver(update);
		ro.observe(scroller);
		return () => ro.disconnect();
	});
</script>

<section>
	<header>
		<div class="heading">
			{#if seeAll}
				<a class="title" href={seeAll}><span class="title-text">{title}</span><Icon name="chevronRight" size={18} /></a>
			{:else}
				<h2 class="title">
					<span class="title-text">{title}</span>
					{#if onRefresh}
						<button class="refresh-btn" aria-label="Refresh" onclick={onRefresh}>
							<Icon name="refresh" size={18} />
						</button>
					{/if}
				</h2>
			{/if}
			{#if subtitle}<p class="subtitle">{subtitle}</p>{/if}
		</div>
		<div class="nav">
			<button aria-label="Scroll left" disabled={atStart} onclick={() => page(-1)}>
				<Icon name="chevronLeft" size={18} />
			</button>
			<button aria-label="Scroll right" disabled={atEnd} onclick={() => page(1)}>
				<Icon name="chevronRight" size={18} />
			</button>
		</div>
	</header>

	<div class="row {size}" bind:this={scroller} onscroll={update}>
		{@render children()}
	</div>
</section>

<style>
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0 var(--gutter);
		margin-bottom: 10px;
	}

	/* one line: a long title ("Because You Listened to …") ends in an ellipsis */
	.title {
		display: flex;
		max-width: 100%;
		align-items: center;
		gap: 2px;
		font-size: 20px;
		font-weight: 700;
		letter-spacing: -0.01em;
		color: var(--text);
		margin: 0;
	}

	.heading {
		flex: 1;
		min-width: 0;
	}

	.title-text {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.title :global(svg),
	.refresh-btn {
		flex-shrink: 0;
	}

	.subtitle {
		margin: 2px 0 0;
		font-size: 13px;
		color: var(--text-2);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	a.title :global(svg) {
		color: var(--text-3);
	}

	.refresh-btn {
		background: none;
		border: none;
		padding: 4px;
		margin-left: 8px;
		color: var(--text-2);
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 50%;
		transition: background-color 0.2s, color 0.2s;
	}
	.refresh-btn:hover {
		background-color: var(--fill);
		color: var(--text);
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
		transition: opacity 0.15s ease, background-color 0.15s ease;
	}

	.nav button:disabled {
		opacity: 0.35;
		cursor: default;
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

		/* TỐI ƯU 2: Cô lập khung cuộn để tránh repaint các phần tử xung quanh */
		contain: layout style;
		-webkit-overflow-scrolling: touch;
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