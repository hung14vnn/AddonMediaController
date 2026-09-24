<script lang="ts">
	import { getLyrics } from '../api';
	import { getPlayer } from '../player.svelte';
	import { artistName } from '../format';
	import type { Lyrics } from '../types';
	import WordSyncedLyrics from './WordSyncedLyrics.svelte';

	const player = getPlayer();
	let lyrics = $state<Lyrics | null>(null);
	let loading = $state(false);
	let container: HTMLDivElement | undefined = $state();
	let userScrolledAt = 0;
	/** null = still trying am-lyrics, true = showing it, false = use the server's lyrics. */
	let wordSynced = $state<boolean | null>(null);
	const song = $derived(player.current);

	// Reset per track; am-lyrics gets the first try.
	$effect(() => {
		void player.current;
		lyrics = null;
		wordSynced = null;
	});

	// Only ask the server once am-lyrics has reported it has nothing for this track.
	$effect(() => {
		const song = player.current;
		if (!song || wordSynced !== false) return;
		let cancelled = false;
		loading = true;
		getLyrics(song).then((l) => {
			if (cancelled) return;
			lyrics = l;
			loading = false;
		});
		return () => (cancelled = true);
	});

	const active = $derived.by(() => {
		if (!lyrics?.synced) return -1;
		const ms = player.currentTime * 1000 + 250;
		let idx = -1;
		for (let i = 0; i < lyrics.lines.length; i++) {
			if ((lyrics.lines[i].start ?? 0) <= ms) idx = i;
			else break;
		}
		return idx;
	});

	$effect(() => {
		if (active < 0 || !container) return;
		// Don't yank the view while the user is reading ahead.
		if (Date.now() - userScrolledAt < 3000) return;
		const el = container.querySelector<HTMLElement>(`[data-i="${active}"]`);
		if (!el) return;
		container.scrollTo({ top: el.offsetTop - container.clientHeight * 0.3, behavior: 'smooth' });
	});
</script>

{#if song && wordSynced !== false}
	{#key song.id}
		<div class="word-synced">
			<WordSyncedLyrics
				title={song.title}
				artist={artistName(song)}
				album={song.album ?? ''}
				durationSeconds={player.duration || song.duration || 0}
				currentTimeSeconds={player.currentTime}
				isPlaying={player.playing}
				isrc={song.isrc?.[0] ?? ''}
				onseek={(s) => player.seek(s)}
				onavailability={(available) => (wordSynced = available)}
			/>
		</div>
	{/key}
{:else}
	<div
		class="lyrics"
		role="region"
		aria-label="Lyrics"
		bind:this={container}
		onwheel={() => (userScrolledAt = Date.now())}
		ontouchmove={() => (userScrolledAt = Date.now())}
	>
		{#if loading}
			<p class="status">Loading lyrics…</p>
		{:else if !lyrics}
			<p class="status">Lyrics aren’t available for this song.</p>
		{:else if lyrics.synced}
			{#each lyrics.lines as line, i}
				<button
					class="line synced"
					class:active={i === active}
					class:past={i < active}
					data-i={i}
					onclick={() => {
						userScrolledAt = 0;
						player.seek((line.start ?? 0) / 1000);
					}}
				>
					{line.value || '♪'}
				</button>
			{/each}
			<div class="spacer"></div>
		{:else}
			{#each lyrics.lines as line}
				<p class="line plain">{line.value || ' '}</p>
			{/each}
		{/if}
	</div>
{/if}

<style>
	.word-synced {
		height: 100%;
		min-height: 0;
	}
	.lyrics {
		height: 100%;
		overflow-y: auto;
		padding: 30vh 8px 0;
		scrollbar-width: none;
		mask-image: linear-gradient(to bottom, transparent, #000 12%, #000 80%, transparent);
		-webkit-mask-image: linear-gradient(to bottom, transparent, #000 12%, #000 80%, transparent);
	}
	.lyrics::-webkit-scrollbar {
		display: none;
	}
	.status {
		color: rgb(255 255 255 / 0.6);
		font-size: 20px;
		font-weight: 600;
		text-align: left;
	}
	.line {
		display: block;
		width: 100%;
		text-align: left;
		font-size: clamp(24px, 3.2vw, 38px);
		font-weight: 700;
		line-height: 1.22;
		letter-spacing: -0.015em;
		padding: 10px 12px;
		margin: 0;
		border-radius: 12px;
		color: rgb(255 255 255 / 0.32);
		transition:
			color 0.35s ease,
			filter 0.35s ease,
			transform 0.35s ease;
		transform-origin: left center;
	}
	.synced {
		filter: blur(1.2px);
	}
	.synced.past {
		filter: blur(0.6px);
	}
	.synced.active {
		color: #fff;
		filter: none;
		transform: scale(1.02);
	}
	.synced:hover {
		background: rgb(255 255 255 / 0.08);
		filter: none;
	}
	.plain {
		font-size: clamp(20px, 2.4vw, 28px);
		color: rgb(255 255 255 / 0.85);
		padding: 2px 12px;
	}
	.spacer {
		height: 50vh;
	}
</style>
