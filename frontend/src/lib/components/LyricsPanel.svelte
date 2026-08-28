<script lang="ts">
	import { formatArtistCredit } from '$lib/utils/formatting';
	import {
		X,
		Music2,
		Loader2,
		AlertCircle,
		Pause,
		Play,
		SkipBack,
		SkipForward,
		Mic,
		ListMusic
	} from 'lucide-svelte';
	import { fade, slide } from 'svelte/transition';
	import type { LyricLine } from '$lib/types';
	import { activeLyricWordIndex, parseWordTimedLyricLine } from '$lib/utils/lyrics';
	import WordSyncedLyrics from '$lib/components/WordSyncedLyrics.svelte';

	interface Props {
		open: boolean;
		lyricsText: string;
		lines?: LyricLine[];
		isSynced?: boolean;
		isLoading?: boolean;
		hasError?: boolean;
		currentTime?: number;
		trackName?: string;
		artistName?: string;
		albumName?: string;
		trackKey?: string;
		coverUrl?: string | null;
		duration?: number;
		isrc?: string;
		preferWordSynced?: boolean;
		source?: string;
		onseek?: (seconds: number) => void;
		isPlaying?: boolean;
		hasPrevious?: boolean;
		hasNext?: boolean;
		ontoggleplay?: () => void;
		onprevious?: () => void;
		onnext?: () => void;
		onopenqueue?: () => void;
		karaokeStatus?: 'idle' | 'preparing' | 'queued' | 'processing' | 'ready' | 'failed';
		karaokeAvailable?: boolean;
		karaokeActive?: boolean;
		karaokeError?: string;
		vocalLevel?: number;
		ontogglekaraoke?: () => void;
		onvocalchange?: (level: number) => void;
		onclose: () => void;
	}

	let {
		open = $bindable(),
		lyricsText,
		lines = [],
		isSynced = false,
		isLoading = false,
		hasError = false,
		currentTime = 0,
		trackName = '',
		artistName = '',
		albumName = '',
		trackKey = '',
		coverUrl = null,
		duration = 0,
		isrc = '',
		preferWordSynced = true,
		source = '',
		onseek = () => {},
		isPlaying = false,
		hasPrevious = false,
		hasNext = false,
		ontoggleplay = () => {},
		onprevious = () => {},
		onnext = () => {},
		onopenqueue = () => {},
		karaokeStatus = 'idle',
		karaokeAvailable = false,
		karaokeActive = false,
		karaokeError = '',
		vocalLevel = 100,
		ontogglekaraoke = () => {},
		onvocalchange = () => {},
		onclose
	}: Props = $props();

	let scrollContainer: HTMLDivElement | undefined = $state();
	let userScrolling = $state(false);
	let scrollTimeout: ReturnType<typeof setTimeout> | undefined;
	let viewMode = $state<'word' | 'library'>('word');
	let timingOffsetMs = $state(0);
	let previousTrackKey: string | null = null;

	const hasLibraryLyrics = $derived(lines.length > 0 || lyricsText.trim().length > 0);
	const adjustedTime = $derived(Math.max(0, currentTime - timingOffsetMs / 1000));

	$effect(() => {
		if (trackKey === previousTrackKey) return;
		previousTrackKey = trackKey;
		viewMode = preferWordSynced ? 'word' : 'library';
		if (typeof localStorage !== 'undefined' && trackKey) {
			timingOffsetMs = Number(localStorage.getItem(`lyrics-offset-${trackKey}`) ?? 0) || 0;
		} else {
			timingOffsetMs = 0;
		}
	});

	function adjustTiming(deltaMs: number) {
		timingOffsetMs = Math.max(-10_000, Math.min(10_000, timingOffsetMs + deltaMs));
		if (typeof localStorage !== 'undefined' && trackKey) {
			localStorage.setItem(`lyrics-offset-${trackKey}`, String(timingOffsetMs));
		}
	}

	function resetTiming() {
		timingOffsetMs = 0;
		if (typeof localStorage !== 'undefined' && trackKey) {
			localStorage.removeItem(`lyrics-offset-${trackKey}`);
		}
	}

	function seekFromLyrics(seconds: number) {
		onseek(Math.max(0, seconds + timingOffsetMs / 1000));
	}

	function formatTime(seconds: number): string {
		if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
		const minutes = Math.floor(seconds / 60);
		const remainder = Math.floor(seconds % 60);
		return `${minutes}:${remainder.toString().padStart(2, '0')}`;
	}

	const timedLines = $derived.by(() => {
		if (!isSynced || lines.length === 0) return [];
		return lines
			.map((line) => ({ ...line, words: parseWordTimedLyricLine(line.text) }))
			.filter((line) => line.start_seconds !== null);
	});

	const activeLineIndex = $derived.by(() => {
		if (timedLines.length === 0) return -1;
		let idx = -1;
		for (let i = 0; i < timedLines.length; i++) {
			if ((timedLines[i].start_seconds ?? 0) <= adjustedTime) {
				idx = i;
			} else {
				break;
			}
		}
		return idx;
	});

	$effect(() => {
		if (activeLineIndex < 0 || userScrolling || !scrollContainer) return;
		const el = scrollContainer.querySelector(`[data-line="${activeLineIndex}"]`);
		if (el) {
			el.scrollIntoView({ behavior: 'smooth', block: 'center' });
		}
	});

	function onUserScroll() {
		userScrolling = true;
		clearTimeout(scrollTimeout);
		scrollTimeout = setTimeout(() => {
			userScrolling = false;
		}, 3000);
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			open = false;
			onclose();
		}
	}
</script>

<div
	class:hidden={!open}
	class="lyrics-stage fixed inset-0 z-[60] flex flex-col overflow-hidden bg-base-100 text-white"
	role="dialog"
	aria-label="Lyrics"
	aria-modal="true"
	tabindex="-1"
	onkeydown={handleKeydown}
>
	{#if coverUrl}
		<img class="lyrics-artwork" src={coverUrl} alt="" aria-hidden="true" />
	{/if}
	<div class="lyrics-wash" aria-hidden="true"></div>
	<div
		class="relative z-10 w-full max-w-5xl mx-auto flex flex-col flex-1 min-h-0"
		transition:slide={{ duration: 250 }}
	>
		<div
			class="relative z-30 flex items-center justify-between gap-3 px-5 py-4 sm:px-8 pointer-events-auto"
		>
			<div class="flex items-center gap-2 min-w-0 flex-1">
				<Music2 class="h-4 w-4 text-white/75 shrink-0" />
				<div class="min-w-0 shrink">
					{#if trackName}
						<p class="text-sm font-semibold truncate">{trackName}</p>
					{/if}
					{#if artistName}
						<p class="text-xs text-white/55 truncate">{formatArtistCredit(artistName)}</p>
					{/if}
				</div>
				<div class="segmented-control shrink-0" aria-label="Lyrics view">
					<button
						class:active={viewMode === 'word'}
						onclick={() => (viewMode = 'word')}
						aria-label="Word-synced lyrics">Word sync</button
					>
					{#if hasLibraryLyrics}
						<button
							class:active={viewMode === 'library'}
							onclick={() => (viewMode = 'library')}
							aria-label="Library lyrics">Library</button
						>
					{/if}
				</div>
			</div>
			<div class="flex items-center gap-1.5 shrink-0">
				<div class="hidden sm:flex items-center gap-1.5 w-44 lg:w-56">
					<span class="text-[10px] text-white/55 tabular-nums w-7 text-right"
						>{formatTime(currentTime)}</span
					>
					<input
						type="range"
						class="range range-xs range-accent flex-1"
						min="0"
						max={duration || 1}
						value={Math.min(currentTime, duration || 1)}
						oninput={(event) => onseek(Number((event.target as HTMLInputElement).value))}
						aria-label="Lyrics playback progress"
					/>
					<span class="text-[10px] text-white/55 tabular-nums w-7">{formatTime(duration)}</span>
				</div>
				<button
					class="btn btn-ghost btn-xs btn-circle"
					onclick={onprevious}
					disabled={!hasPrevious}
					aria-label="Previous track"><SkipBack class="h-4 w-4" /></button
				>
				<button
					class="btn btn-primary btn-xs btn-circle"
					onclick={ontoggleplay}
					aria-label={isPlaying ? 'Pause' : 'Play'}
					>{#if isPlaying}<Pause class="h-4 w-4" />{:else}<Play class="h-4 w-4" />{/if}</button
				>
				<button
					class="btn btn-ghost btn-xs btn-circle"
					onclick={onnext}
					disabled={!hasNext}
					aria-label="Next track"><SkipForward class="h-4 w-4" /></button
				>
				<button
					class="btn btn-ghost btn-xs btn-circle"
					onclick={onopenqueue}
					aria-label="Toggle queue"
					title="Queue"><ListMusic class="h-4 w-4" /></button
				>
				<button
					class="btn btn-ghost btn-sm btn-circle"
					onclick={() => {
						open = false;
						onclose();
					}}
					aria-label="Close lyrics"
				>
					<X class="h-4 w-4" />
				</button>
			</div>
		</div>

		<div class="relative z-0 min-h-0 flex-1">
			{#if viewMode === 'word'}
				{#key trackKey}
					<WordSyncedLyrics
						title={trackName}
						artist={artistName}
						album={albumName}
						durationSeconds={duration}
						currentTimeSeconds={adjustedTime}
						{isrc}
						onseek={seekFromLyrics}
					/>
				{/key}
			{:else}
				<div
					bind:this={scrollContainer}
					class="scrollbar-hide h-full overflow-y-auto px-8 py-[22vh]"
					onscroll={onUserScroll}
				>
					{#if karaokeStatus === 'preparing' || karaokeStatus === 'queued' || karaokeStatus === 'processing'}
						<div
							class="sticky top-0 z-10 mx-auto mb-8 flex w-fit items-center gap-2 rounded-full bg-base-100/85 px-4 py-2 text-sm shadow-lg backdrop-blur"
						>
							<Loader2 class="h-4 w-4 animate-spin text-accent" />
							{karaokeStatus === 'queued' ? 'Karaoke is queued' : 'Creating karaoke stems...'}
						</div>
					{:else if karaokeStatus === 'failed'}
						<div
							class="sticky top-0 z-10 mx-auto mb-8 w-fit rounded-full bg-error/15 px-4 py-2 text-sm text-error"
						>
							{karaokeError || 'Karaoke generation failed'}
						</div>
					{/if}
					{#if isLoading}
						<div class="flex flex-col items-center justify-center py-12 gap-3">
							<Loader2 class="h-6 w-6 animate-spin text-primary" />
							<p class="text-sm text-base-content/50">Loading lyrics...</p>
						</div>
					{:else if hasError}
						<div class="flex flex-col items-center justify-center py-8 gap-2">
							<AlertCircle class="h-5 w-5 text-warning" />
							<p class="text-center text-base-content/50 text-sm">
								Couldn't load the lyrics. Try again in a bit.
							</p>
						</div>
					{:else if timedLines.length > 0}
						<div class="space-y-5">
							{#each timedLines as line, i (i)}
								<button
									type="button"
									data-line={i}
									onclick={() => seekFromLyrics(line.start_seconds ?? 0)}
									class="block w-full text-left text-2xl sm:text-4xl font-bold leading-tight transition-all duration-300 cursor-pointer hover:underline
									{i === activeLineIndex
										? `${line.words.length > 0 ? 'text-primary' : 'text-accent'} scale-[1.02]`
										: ''}
									{i !== activeLineIndex && i < activeLineIndex ? 'opacity-45' : ''}
									{i > activeLineIndex ? 'opacity-30' : ''}"
								>
									{#if line.words.length > 0}
										{@const activeWordIndex =
											i === activeLineIndex ? activeLyricWordIndex(line.words, adjustedTime) : -1}
										{#each line.words as word, wordIndex (wordIndex)}
											<span
												class="lyrics-word transition-colors duration-150"
												class:text-accent={i === activeLineIndex && wordIndex === activeWordIndex}
												class:text-primary={i === activeLineIndex && wordIndex < activeWordIndex}
												class:opacity-40={i === activeLineIndex && wordIndex > activeWordIndex}
											>
												{word.text}
											</span>
										{/each}
									{:else}
										{line.text}
									{/if}
								</button>
							{/each}
						</div>
					{:else if lyricsText.trim()}
						<pre
							class="whitespace-pre-wrap font-sans text-sm leading-relaxed text-base-content/80">{lyricsText}</pre>
					{:else}
						<p class="text-center text-base-content/40 py-8">
							Lyrics aren't available for this track.
						</p>
					{/if}
				</div>
			{/if}
		</div>

		{#if karaokeActive}
			<div
				class="absolute right-2 top-1/2 z-20 flex -translate-y-1/2 flex-col items-center gap-2 rounded-full bg-base-100/80 px-2 py-3 shadow-xl backdrop-blur sm:right-5"
				transition:fade={{ duration: 180 }}
			>
				<Mic class="h-4 w-4 text-accent" />
				<div class="flex h-36 w-8 items-center justify-center">
					<input
						type="range"
						class="vocal-level-slider"
						min="0"
						max="100"
						value={vocalLevel}
						oninput={(event) => onvocalchange(Number((event.target as HTMLInputElement).value))}
						aria-label="Original vocal level"
					/>
				</div>
				<span class="text-[10px] tabular-nums text-base-content/60">{Math.round(vocalLevel)}%</span>
			</div>
		{/if}

		<div class="px-5 py-3 sm:px-8 flex items-center justify-between gap-3 text-xs text-white/55">
			<div class="flex gap-2">
				{#if viewMode === 'word'}
					<span>LyricsPlus · Apple Music fallback</span>
				{:else}
					{#if isSynced}<span class="badge badge-xs border-white/20 bg-white/10 text-white"
							>Synced</span
						>{/if}
					{#if source === 'lrclib'}<span>Lyrics from LRCLIB</span>{/if}
				{/if}
			</div>
			<div class="timing-controls" aria-label="Lyrics timing offset">
				<button onclick={() => adjustTiming(-500)} aria-label="Lyrics earlier by half a second"
					>−</button
				>
				<button onclick={resetTiming} title="Reset timing offset"
					>{timingOffsetMs >= 0 ? '+' : ''}{(timingOffsetMs / 1000).toFixed(1)}s</button
				>
				<button onclick={() => adjustTiming(500)} aria-label="Lyrics later by half a second"
					>+</button
				>
			</div>
			{#if karaokeAvailable}
				<button
					class="btn btn-sm rounded-full {karaokeActive ? 'btn-accent' : 'btn-ghost'}"
					disabled={karaokeStatus === 'preparing' ||
						karaokeStatus === 'queued' ||
						karaokeStatus === 'processing'}
					onclick={ontogglekaraoke}
					aria-label={karaokeActive ? 'Turn off karaoke' : 'Create or enable karaoke'}
				>
					<Mic class="h-4 w-4" />
					{karaokeActive ? 'Karaoke on' : karaokeStatus === 'ready' ? 'Enable karaoke' : 'Karaoke'}
				</button>
			{/if}
		</div>
	</div>
</div>

<style>
	.lyrics-artwork {
		position: absolute;
		inset: -15%;
		height: 130%;
		width: 130%;
		object-fit: cover;
		filter: blur(48px) saturate(1.15);
		opacity: 0.2;
	}

	.lyrics-wash {
		position: absolute;
		inset: 0;
		background: linear-gradient(180deg, rgba(5, 5, 5, 0.45), rgba(5, 5, 5, 0.86));
	}
	.segmented-control,
	.timing-controls {
		display: flex;
		align-items: center;
		gap: 0.2rem;
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.05);
		padding: 0.2rem;
		backdrop-filter: blur(16px);
	}

	.segmented-control button,
	.timing-controls button {
		border: 0;
		border-radius: 999px;
		background: transparent;
		color: rgba(255, 255, 255, 0.58);
		padding: 0.35rem 0.7rem;
		font-size: 0.72rem;
		font-weight: 650;
		transition: 180ms ease;
	}

	.segmented-control button:hover,
	.timing-controls button:hover,
	.segmented-control button.active {
		background: rgba(255, 255, 255, 0.12);
		color: white;
	}

	@media (max-width: 640px) {
		.segmented-control {
			position: absolute;
			top: 4.6rem;
			left: 50%;
			z-index: 20;
			transform: translateX(-50%);
		}
	}

	.vocal-level-slider {
		width: 1rem;
		height: 9rem;
		writing-mode: vertical-lr;
		direction: rtl;
		appearance: slider-vertical;
		accent-color: var(--color-accent);
		cursor: pointer;
	}

	.lyrics-word:not(:last-child)::after {
		content: ' ';
	}
</style>
