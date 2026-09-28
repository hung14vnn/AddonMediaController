<script lang="ts">
	import { page } from '$app/state';
	import Album from '$lib/views/Album.svelte';
</script>

<Album id={page.params.id!} />
