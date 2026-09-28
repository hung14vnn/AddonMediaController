<script lang="ts">
	import { page } from '$app/state';
	import Artist from '$lib/views/Artist.svelte';
</script>

<Artist id={page.params.id!} />
