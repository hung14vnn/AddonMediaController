<script lang="ts">
	import { getGenres } from '../api';
	import ErrorState from '../components/ErrorState.svelte';
	import GenreTiles from '../components/GenreTiles.svelte';
import Icon from '../components/Icon.svelte';
import { router } from '../router.svelte';

	let data = $state(getGenres());
</script>

<div class="page">
	<div class="head"><button class="back" onclick={() => router.go('/library')}><Icon name="chevronLeft" size={18} />Library</button></div>
	<h1 class="page-title">Genres</h1>
	{#await data}
		<div class="spinner"></div>
	{:then genres}
		{#if genres.length}
			<GenreTiles {genres} />
		{:else}
			<div class="empty-state"><h3>No Genres</h3></div>
		{/if}
	{:catch error}
		<ErrorState {error} retry={() => (data = getGenres())} />
	{/await}
</div>

<style>
	.head { display: flex; align-items: center; padding: 0 var(--gutter); margin-bottom: 8px; }
	.back { display: inline-flex; align-items: center; gap: 2px; color: var(--accent); font-size: 14px; }
</style>
