<script lang="ts">
	import { getGenres } from '../api';
	import ErrorState from '../components/ErrorState.svelte';
	import GenreTiles from '../components/GenreTiles.svelte';

	let data = $state(getGenres());
</script>

<div class="page">
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
