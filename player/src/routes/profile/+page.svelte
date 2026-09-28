<script lang="ts">
	import { auth } from '$lib/session.svelte';
	import Profile from '$lib/views/Profile.svelte';
</script>

<Profile onsignout={() => auth.signOut()} />
