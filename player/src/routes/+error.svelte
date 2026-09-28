<script lang="ts">
	import { onMount } from 'svelte';
	import { router } from '$lib/router.svelte';

	// Unknown paths fall back to Home, as the old hand-rolled router did.
	onMount(() => {
		router.go('/', true);
	});
</script>
