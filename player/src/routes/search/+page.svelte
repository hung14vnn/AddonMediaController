<script lang="ts">
	import { router } from '$lib/router.svelte';
	import Search from '$lib/views/Search.svelte';

	const query = $derived(router.route.name === 'search' ? router.route.query : '');
</script>

<Search {query} />
