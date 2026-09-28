<script lang="ts">
	import { page } from '$app/state';
	import Genre from '$lib/views/Genre.svelte';
</script>

<Genre id={page.params.id!} />
