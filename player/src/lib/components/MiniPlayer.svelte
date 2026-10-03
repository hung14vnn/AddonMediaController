<script lang="ts">
	// Floating mini player above the tab bar (iOS 26-style pill).
	import { getPlayer } from '../player.svelte';
	import { artSwap, pop, rise, textSwap } from '../motion';
	import { ui } from '../ui.svelte';
	import Artwork from './Artwork.svelte';
	import Icon from './Icon.svelte';

	const player = getPlayer();
	const song = $derived(player.current);
</script>

{#if song}
	<div class="mini" in:rise out:rise={{ duration: 220 }}>
		<button class="open" onclick={() => ui.openNowPlaying()} aria-label="Open Now Playing">
			{#key song.id}
				<span class="art" in:artSwap={{ duration: 320 }}>
					<Artwork id={song.coverArt} size={64} seed={song.album ?? song.title} />
				</span>
				<span class="title ellipsis" in:textSwap>{song.title}</span>
			{/key}
		</button>
		<button class="ctl has-ring" aria-label={player.active ? 'Pause' : 'Play'} onclick={() => player.toggle()}>
			{#key player.active}
				<span class="icon-swap" in:pop={{ from: 0.5, duration: 200 }}>
					<Icon name={player.active ? 'pause' : 'play'} size={24} />
				</span>
			{/key}
			{#if player.buffering}<span class="loading-ring"></span>{/if}
		</button>
		<button class="ctl" aria-label="Next" onclick={() => player.next()}>
			<Icon name="next" size={24} />
		</button>
	</div>
{/if}

<style>
	.mini {
		position: relative;
		display: flex;
		align-items: center;
		gap: 4px;
		height: 56px;
		margin: 0 10px 8px;
		padding: 0 8px 0 6px;
		border-radius: 16px;
		background: var(--chrome-strong, rgba(30, 30, 30, 0.95));
		box-shadow:
			0 6px 24px rgb(0 0 0 / 0.16),
			inset 0 0 0 0.5px var(--hairline);
		overflow: hidden;
	}

	.open {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 12px;
		height: 100%;
		text-align: left;
	}
	.art {
		/* never shrink the artwork to make room for a long title */
		flex: none;
		width: 44px;
		--art-radius: 7px;
		--art-shadow: 0 2px 8px rgb(0 0 0 / 0.18);
	}
	.title {
		flex: 1;
		min-width: 0;
		font-size: 15px;
		font-weight: 500;
	}
	.ctl {
		width: 44px;
		height: 44px;
		display: grid;
		place-items: center;
		color: var(--text);
	}
</style>