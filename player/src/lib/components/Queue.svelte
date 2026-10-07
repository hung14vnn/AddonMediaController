<script lang="ts">
	import { smartDiscover } from "../discover.svelte";
	import { artistName } from "../format";
	import { fadeOnly, queueItem } from "../motion";
	import { getPlayer } from "../player.svelte";
	import { audioSettings } from "../playback/audioSettings.svelte";
	import Artwork from "./Artwork.svelte";
	import Icon from "./Icon.svelte";
	import { flip } from "svelte/animate";
	import { onMount } from "svelte";

	const player = getPlayer();
	let queueContent: HTMLDivElement;
	let playingNextHeader: HTMLElement;
	let dragFrom = $state<number | null>(null);
	let dragOver = $state<number | null>(null);
	let animateQueueChanges = $state(true);
	let clearingQueue = $state(false);
	let clearTimers: ReturnType<typeof setTimeout>[] = [];
	let touchDrag = $state<{ pointerId: number; from: number } | null>(null);

	function scrollToPlayingNext(behavior: ScrollBehavior = "smooth") {
		if (!queueContent || !playingNextHeader) return;
		queueContent.scrollTo({
			top: playingNextHeader.offsetTop - queueContent.offsetTop,
			behavior,
		});
	}

	onMount(() => {
		requestAnimationFrame(() => scrollToPlayingNext("auto"));
	});

	function moveTouchDrag(event: PointerEvent) {
		if (!touchDrag || event.pointerId !== touchDrag.pointerId) return;
		const row = document
			.elementFromPoint(event.clientX, event.clientY)
			?.closest<HTMLElement>("li[data-queue-index]");
		const index = Number(row?.dataset.queueIndex);
		dragOver = Number.isNaN(index) ? null : index;
	}

	function finishTouchDrag(event: PointerEvent) {
		if (!touchDrag || event.pointerId !== touchDrag.pointerId) return;
		moveTouchDrag(event);
		if (dragOver !== null && dragOver !== touchDrag.from)
			player.moveUpNext(touchDrag.from, dragOver);
		touchDrag = null;
		dragOver = null;
	}

	function toggleShuffle() {
		animateQueueChanges = false;
		player.toggleShuffle();
		requestAnimationFrame(() => (animateQueueChanges = true));
	}

	function clearQueue() {
		if (!player.upNext.length) return;

		scrollToPlayingNext();

		const count = player.upNext.length;
		clearingQueue = true;
		clearTimers.forEach((timer) => clearTimeout(timer));
		clearTimers = [];

		const animateCount = Math.min(count, 20);
		if (count > animateCount) {
			player.clearUpNext(animateCount);
		}

		// Remove from the bottom upward. Removing the whole array at once makes
		// the browser reflow every outgoing row to the first line before it can
		// play its horizontal outro.
		for (let step = animateCount - 1; step >= 0; step--) {
			const delay = (animateCount - 1 - step) * 45;
			clearTimers.push(
				setTimeout(
					() => player.removeAt(player.index + 1 + step),
					delay,
				),
			);
		}
		clearTimers.push(
			setTimeout(
				() => (clearingQueue = false),
				(animateCount - 1) * 45 + 220,
			),
		);
	}

	function jumpToTrack(index: number) {
		// Jumping skips every preceding track at once. Disable the staggered
		// per-row outro so the remaining queue does not get pushed down one item
		// at a time while the skipped rows animate away.
		animateQueueChanges = false;
		player.jumpTo(index);
		requestAnimationFrame(() => {
			animateQueueChanges = true;
			scrollToPlayingNext();
		});
	}
</script>

<div class="queue">
	<div class="toggles controls">
		{#if player.queue.length > 0}
			<button
				class="smart-discover"
				class:discovering={smartDiscover.discovering}
				onclick={() => smartDiscover.run()}
				disabled={smartDiscover.discovering}
				aria-label="Smart Discover — add related tracks to queue"
				title="Smart Discover"
			>
				{#if smartDiscover.discovering}
					<span class="spin" aria-hidden="true"></span>
				{:else}
					<Icon name="discover" size={19} />
				{/if}
			</button>
		{/if}
		<button
			class:on={player.shuffle}
			aria-pressed={player.shuffle}
			aria-label="Shuffle"
			onclick={toggleShuffle}
		>
			<Icon name="shuffle" size={19} />
		</button>
		<button
			class:on={player.repeat !== "off"}
			aria-label="Repeat {player.repeat}"
			onclick={() => player.cycleRepeat()}
		>
			<Icon name={player.repeat === "one" ? "repeatOne" : "repeat"} size={19} />
		</button>
		<button
			class:on={player.webAudio && audioSettings.crossfade}
			aria-pressed={player.webAudio && audioSettings.crossfade}
			disabled={!player.webAudio}
			aria-label={player.webAudio
				? "Crossfade"
				: "Crossfade — requires the Web Audio engine (Account › Playback)"}
			title={player.webAudio ? "Crossfade" : "Crossfade requires the Web Audio engine"}
			onclick={() => audioSettings.setCrossfade(!audioSettings.crossfade)}
		>
			<Icon name="crossfade" size={19} />
		</button>
	</div>

	<div class="queue-content" bind:this={queueContent}>
	{#if player.history.length}
		<section class="history" aria-label="Playback history">
			<h3>History</h3>
			<ol>
				{#each player.history as song, i (song)}
					<li class="history-item">
						<button class="item" onclick={() => jumpToTrack(i)}>
							<span class="art"><Artwork id={song.coverArt} size={64} seed={song.album ?? song.title} /></span>
							<span class="text">
								<span class="title ellipsis">{song.title}</span>
								<span class="artist ellipsis">{artistName(song)}</span>
							</span>
						</button>
						<button class="remove" aria-label="Remove {song.title} from history" onclick={() => player.removeAt(i)}>
							<Icon name="close" size={16} />
						</button>
					</li>
				{/each}
			</ol>
		</section>
	{/if}
	<header bind:this={playingNextHeader}>
		<h3>Playing Next</h3>
		{#if player.upNext.length}<button class="clear" onclick={clearQueue}>Clear</button>{/if}
	</header>

		{#if !player.upNext.length}
			<p
				class="empty"
				in:fadeOnly={{ duration: 220 }}
				out:fadeOnly={{ duration: 160 }}
			>
				Nothing up next. Use “Play Next” on any song to add it here.
			</p>
		{/if}
		<ol>
			{#each player.upNext as song, j (song)}
				{@const i = player.index + 1 + j}
				<li
					data-queue-index={i}
					in:queueItem={{
						direction: -1,
						duration: animateQueueChanges ? 220 : 0,
						delay: animateQueueChanges ? j * 45 : 0,
					}}
					out:queueItem={{
						direction: 1,
						duration: animateQueueChanges ? 220 : 0,
						delay: clearingQueue
							? 0
							: animateQueueChanges
								? j * 45
								: 0,
					}}
					animate:flip={{ duration: clearingQueue ? 0 : 500 }}
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
						if (dragFrom !== null && dragFrom !== i)
							player.moveUpNext(dragFrom, i);
						dragFrom = dragOver = null;
					}}
					ondragend={() => (dragFrom = dragOver = null)}
				>
					<button class="item" onclick={() => jumpToTrack(i)}>
						<span class="art"
							><Artwork
								id={song.coverArt}
								size={64}
								seed={song.album ?? song.title}
							/></span
						>
						<span class="text">
							<span class="title ellipsis">{song.title}</span>
							<span class="artist ellipsis"
								>{artistName(song)}</span
							>
						</span>
					</button>
					<button
						class="remove"
						aria-label="Remove {song.title}"
						onclick={() => player.removeAt(i)}
					>
						<Icon name="close" size={16} />
					</button>
					<button
						class="drag-handle"
						aria-label="Reorder {song.title}"
						onpointerdown={(event) => {
							if (event.pointerType === "mouse") return;
							event.preventDefault();
							event.currentTarget.setPointerCapture(event.pointerId);
							touchDrag = { pointerId: event.pointerId, from: i };
							dragOver = i;
						}}
						onpointermove={moveTouchDrag}
						onpointerup={finishTouchDrag}
						onpointercancel={finishTouchDrag}
					>☰</button>
				</li>
			{/each}
		</ol>
	</div>
</div>

<style>
	.queue {
		height: 100%;
		padding: 8px 4px 0;
		color: #fff;
		display: flex;
		flex-direction: column;
	}
	.queue-content {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		overflow-x: hidden;
		display: flex;
		flex-direction: column;

		/* Firefox & W3C Standard: thumb color | track color */
		scrollbar-width: thin;
		scrollbar-color: rgba(255, 255, 255, 0.3) transparent;
	}
	.queue-content > :global(*) {
		flex-shrink: 0;
	}
	.history {
		flex-shrink: 0;
		padding-bottom: 10px;
	}
	.history h3 {
		padding: 0 8px 6px;
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0 8px 8px;
		flex-shrink: 0;
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
	.controls {
		padding: 10px 8px 12px;
		flex-shrink: 0;
	}
	.controls button {
		flex: 1;
	}
	.toggles button {
		height: 36px;
		min-width: 30px;
		padding: 0 8px;
		border-radius: 999px;
		display: grid;
		place-items: center;
		color: rgb(255 255 255 / 0.8);
		background: rgb(255 255 255 / 0.12);
		font-size: 13px;
		font-weight: 600;
	}
	.toggles button:disabled:not(.discovering) {
		opacity: 0.4;
	}
	.toggles button.on {
		background: rgb(255 255 255 / 0.85);
		color: #000;
	}
	.clear {
		height: 30px;
		padding: 0 10px;
		border-radius: 8px;
		color: rgb(255 255 255 / 0.9);
		background: rgb(255 255 255 / 0.12);
		font-size: 13px;
		font-weight: 600;
	}
	.smart-discover {
		position: relative;
	}
	.smart-discover.discovering {
		cursor: wait;
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
		flex-shrink: 0;
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
	.drag-handle {
		display: none;
		width: 30px;
		height: 38px;
		padding: 0;
		color: rgb(255 255 255 / 0.5);
		font-size: 15px;
		touch-action: none;
	}
	li:hover .remove,
	.remove:focus-visible {
		opacity: 1;
	}
	@media (hover: none) {
		.remove {
			opacity: 1;
		}
		.drag-handle {
			display: grid;
			place-items: center;
		}
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
