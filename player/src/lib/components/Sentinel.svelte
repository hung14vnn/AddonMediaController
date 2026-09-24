<script lang="ts">
	// Calls onvisible when scrolled near; drives infinite paging.
	let { onvisible, loading = false }: { onvisible: () => void; loading?: boolean } = $props();
	let el: HTMLDivElement | undefined = $state();

	$effect(() => {
		if (!el) return;
		const io = new IntersectionObserver((entries) => entries[0].isIntersecting && onvisible(), {
			rootMargin: '600px'
		});
		io.observe(el);
		return () => io.disconnect();
	});
</script>

<div bind:this={el} class="sentinel">
	{#if loading}<div class="spinner"></div>{/if}
</div>

<style>
	.sentinel {
		min-height: 1px;
	}
</style>
