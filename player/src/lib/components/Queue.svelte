<script lang="ts">
	import { smartDiscover } from '../discover.svelte';
	import { artistName } from '../format';
	import { getPlayer } from '../player.svelte';
	import Artwork from './Artwork.svelte';
	import Icon from './Icon.svelte';

	const player = getPlayer();
	let dragFrom = $state<number | null>(null);
	let dragOver = $state<number | null>(null);
</script>

<div class="queue">
	<header>
		<h3>Playing Next</h3>
		<div class="toggles">
			<button class:on={player.shuffle} aria-pressed={player.shuffle} aria-label="Shuffle" onclick={() => player.toggleShuffle()}>
				<Icon name="shuffle" size={17} />
			</button>
			<button class:on={player.repeat !== 'off'} aria-label="Repeat {player.repeat}" onclick={() => player.cycleRepeat()}>
				<Icon name={player.repeat === 'one' ? 'repeatOne' : 'repeat'} size={17} />
			</button>
			{#if player.upNext.length}
				<button class="clear" onclick={() => player.clearUpNext()}>Clear</button>
			{/if}
		</div>
	</header>

	{#if !player.upNext.length}
		<p class="empty">Nothing up next. Use “Play Next” on any song to add it here.</p>
	{:else}
		<ol>
			{#each player.upNext as song, j (song.id + ':' + j)}
				{@const i = player.index + 1 + j}
				<li
					draggable="true"
					class:over={dragOver === i}
					ondragstart={() => (dragFrom = i)}
					ondragover={(e) => {
						e.preventDefault();
						dragOver = i;
					}}
					ondragleave={() => dragOver === i && (dragOver = null)}
					ondrop={(e) => {
						e.preventDefault();
						if (dragFrom !== null && dragFrom !== i) player.moveUpNext(dragFrom, i);
						dragFrom = dragOver = null;
					}}
					ondragend={() => (dragFrom = dragOver = null)}
				>
					<button class="item" onclick={() => player.jumpTo(i)}>
						<span class="art"><Artwork id={song.coverArt} size={64} seed={song.album ?? song.title} /></span>
						<span class="text">
							<span class="title ellipsis">{song.title}</span>
							<span class="artist ellipsis">{artistName(song)}</span>
						</span>
					</button>
					<button class="remove" aria-label="Remove {song.title}" onclick={() => player.removeAt(i)}>
						<Icon name="close" size={16} />
					</button>
				</li>
			{/each}
		</ol>
	{/if}
	{#if player.queue.length > 0}
		<div class="discover-dock">
			<button
				class="smart-discover-btn"
				class:discovering={smartDiscover.discovering}
				onclick={() => smartDiscover.run()}
				disabled={smartDiscover.discovering}
				aria-label="Smart Discover — add related tracks to queue"
			>
				{#if smartDiscover.discovering}
					<span class="spin" aria-hidden="true"></span>
					<span>Discovering…</span>
				{:else}
					<span>Smart Discover</span>
				{/if}
			</button>
		</div>
	{/if}
</div>

<style>
	/* Flex column so the Smart Discover dock can sit at the bottom (margin-top: auto)
	   even when the list is short; sticky keeps it pinned there once it scrolls. */
	.queue {
		height: 100%;
		overflow-y: auto;
		padding: 8px 4px 0;
		color: #fff;
		display: flex;
		flex-direction: column;

		/* Firefox & W3C Standard: thumb color | track color */
		scrollbar-width: thin;
		scrollbar-color: rgba(255, 255, 255, 0.3) transparent;
	}
	.queue > :global(*) {
		flex-shrink: 0;
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0 8px 8px;
		position: sticky;
		top: 0;
		z-index: 1;
	}
	h3 {
		margin: 0;
		font-size: 17px;
		font-weight: 700;
	}
	.toggles {
		display: flex;
		gap: 8px;
	}
	.toggles button {
		height: 30px;
		min-width: 30px;
		padding: 0 8px;
		border-radius: 8px;
		display: grid;
		place-items: center;
		color: rgb(255 255 255 / 0.8);
		background: rgb(255 255 255 / 0.12);
		font-size: 13px;
		font-weight: 600;
	}
	.toggles button.on {
		background: rgb(255 255 255 / 0.85);
		color: #000;
	}
	.empty {
		padding: 16px 8px;
		color: rgb(255 255 255 / 0.6);
		font-size: 14px;
	}
	ol {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	li {
		display: flex;
		align-items: center;
		border-radius: 10px;
		border-top: 2px solid transparent;
	}
	li.over {
		border-top-color: rgb(255 255 255 / 0.7);
	}
	li:hover {
		background: rgb(255 255 255 / 0.08);
	}
	.item {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 6px 8px;
		text-align: left;
		color: inherit;
	}
	.art {
		width: 42px;
		--art-radius: 5px;
	}
	.text {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.title {
		font-size: 14px;
		font-weight: 500;
	}
	.artist {
		font-size: 13px;
		color: rgb(255 255 255 / 0.6);
	}
	.remove {
		width: 32px;
		height: 32px;
		margin-right: 4px;
		display: grid;
		place-items: center;
		color: rgb(255 255 255 / 0.55);
		opacity: 0;
	}
	li:hover .remove,
	.remove:focus-visible {
		opacity: 1;
	}
	@media (hover: none) {
		.remove {
			opacity: 1;
		}
	}
	/* Floats over the list's bottom edge; sticky keeps it inside the scroller. */
	.discover-dock {
		position: sticky;
		bottom: 0;
		display: flex;
		justify-content: center;
		padding: 28px 0 18px;
		margin-top: auto;
		pointer-events: none;
	}
	.smart-discover-btn {
		pointer-events: auto;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;
		padding: 0.5rem 1.2rem;
		border-radius: 9999px;
		border: 0.5px solid rgb(255 255 255 / 0.18);
		font-size: 0.85rem;
		font-weight: 500;
		color: #fff;
		background: rgb(40 40 40 / 0.72);
		backdrop-filter: blur(12px) saturate(1.6);
		-webkit-backdrop-filter: blur(12px) saturate(1.6);
		box-shadow: 0 4px 14px rgb(0 0 0 / 0.4);
		transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
	}
	.smart-discover-btn:hover:not(:disabled) {
		transform: scale(1.03);
		background: rgb(60 60 60 / 0.82);
	}
	.smart-discover-btn:active:not(:disabled) {
		transform: scale(0.97);
	}
	.smart-discover-btn:disabled {
		opacity: 0.7;
		cursor: not-allowed;
	}
	.smart-discover-btn.discovering {
	}
	.spin {
		width: 14px;
		height: 14px;
		border-radius: 50%;
		border: 2px solid rgb(255 255 255 / 0.3);
		border-top-color: #fff;
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
