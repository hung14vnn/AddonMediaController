<script lang="ts">
	import AlbumGrid from './AlbumGrid.svelte';
	import Songs from './Songs.svelte';

	let { id }: { id: string } = $props();
	let tab = $state<'albums' | 'songs'>('albums');
</script>

<div class="genre">
	<div class="seg-wrap">
		<div class="seg" role="tablist">
			<button role="tab" aria-selected={tab === 'albums'} class:on={tab === 'albums'} onclick={() => (tab = 'albums')}>Albums</button>
			<button role="tab" aria-selected={tab === 'songs'} class:on={tab === 'songs'} onclick={() => (tab = 'songs')}>Songs</button>
		</div>
	</div>
	{#key id + tab}
		{#if tab === 'albums'}
			<AlbumGrid title={id} genre={id} />
		{:else}
			<h1 class="page-title songs-title">{id}</h1>
			<Songs genre={id} />
		{/if}
	{/key}
</div>

<style>
	.genre {
		position: relative;
	}
	.seg-wrap {
		position: absolute;
		right: var(--gutter);
		top: 30px;
		z-index: 1;
	}
	.seg {
		display: grid;
		grid-template-columns: 1fr 1fr;
		padding: 2px;
		border-radius: 9px;
		background: var(--fill);
	}
	.seg button {
		height: 28px;
		padding: 0 16px;
		border-radius: 7px;
		font-size: 13px;
		font-weight: 500;
		color: var(--text-2);
	}
	.seg button.on {
		color: var(--text);
		background: var(--bg-elevated);
		box-shadow: 0 1px 4px rgb(0 0 0 / 0.12);
	}
	.songs-title {
		padding-top: 28px;
		margin-bottom: 0;
	}
	@media (max-width: 899px) {
		.seg-wrap {
			position: static;
			padding: max(16px, env(safe-area-inset-top)) var(--gutter) 0;
		}
	}
</style>
