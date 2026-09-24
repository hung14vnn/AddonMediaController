<script lang="ts">
	let { error, retry }: { error: unknown; retry?: () => void } = $props();
</script>

<div class="empty-state">
	<h3>Something went wrong</h3>
	<p>{error instanceof Error ? error.message : String(error)}</p>
	{#if retry}<button class="btn secondary" onclick={retry}>Try Again</button>{/if}
</div>
