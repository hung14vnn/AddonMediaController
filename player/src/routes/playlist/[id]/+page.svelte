<script lang="ts">
	import { page } from '$app/state';
	import Playlist from '$lib/views/Playlist.svelte';
</script>

<Playlist id={page.params.id!} />
