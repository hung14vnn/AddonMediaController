<script lang="ts">
	import { X, Music2, Loader2, AlertCircle, Pause, Play, SkipBack, SkipForward } from 'lucide-svelte';
	import { slide } from 'svelte/transition';
	import type { LyricLine } from '$lib/types';

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
		source?: string;
		onseek?: (seconds: number) => void;
		isPlaying?: boolean;
		hasPrevious?: boolean;
		hasNext?: boolean;
		ontoggleplay?: () => void;
		onprevious?: () => void;
		onnext?: () => void;
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
		source = '',
		onseek = () => {},
		isPlaying = false,
		hasPrevious = false,
		hasNext = false,
		ontoggleplay = () => {},
		onprevious = () => {},
		onnext = () => {},
		onclose
	}: Props = $props();

	let scrollContainer: HTMLDivElement | undefined = $state();
	let userScrolling = $state(false);
	let scrollTimeout: ReturnType<typeof setTimeout> | undefined;

	const timedLines = $derived(
		isSynced && lines.length > 0 ? lines.filter((l) => l.start_seconds !== null) : []
	);

	const activeLineIndex = $derived.by(() => {
		if (timedLines.length === 0) return -1;
		let idx = -1;
		for (let i = 0; i < timedLines.length; i++) {
			if ((timedLines[i].start_seconds ?? 0) <= currentTime) {
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

{#if open}
	<div
		class="fixed inset-0 z-[60] flex flex-col bg-base-300/95 backdrop-blur-xl"
		role="dialog"
		aria-label="Lyrics"
		aria-modal="true"
		tabindex="-1"
		onkeydown={handleKeydown}
	>
		<div
			class="w-full max-w-3xl mx-auto flex flex-col flex-1 min-h-0"
			transition:slide={{ duration: 250 }}
		>
			<div class="flex items-center justify-between px-5 py-4 border-b border-base-content/10">
				<div class="flex items-center gap-2 min-w-0">
					<Music2 class="h-4 w-4 text-primary shrink-0" />
					<div class="min-w-0">
						{#if trackName}
							<p class="text-sm font-semibold truncate">{trackName}</p>
						{/if}
						{#if artistName}
							<p class="text-xs text-base-content/60 truncate">{artistName}</p>
						{/if}
					</div>
				</div>
				<div class="flex items-center gap-1 shrink-0">
					<button class="btn btn-ghost btn-sm btn-circle" onclick={onprevious} disabled={!hasPrevious} aria-label="Previous track"><SkipBack class="h-4 w-4" /></button>
					<button class="btn btn-primary btn-sm btn-circle" onclick={ontoggleplay} aria-label={isPlaying ? 'Pause' : 'Play'}>{#if isPlaying}<Pause class="h-4 w-4" />{:else}<Play class="h-4 w-4" />{/if}</button>
					<button class="btn btn-ghost btn-sm btn-circle" onclick={onnext} disabled={!hasNext} aria-label="Next track"><SkipForward class="h-4 w-4" /></button>
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

			<div
				bind:this={scrollContainer}
				class="overflow-y-auto px-8 py-[22vh] flex-1"
				onscroll={onUserScroll}
			>
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
								onclick={() => onseek(line.start_seconds ?? 0)}
								class="block w-full text-left text-2xl sm:text-4xl font-bold leading-tight transition-all duration-300
									{i === activeLineIndex ? 'text-primary scale-[1.02]' : ''}
									{i !== activeLineIndex && i < activeLineIndex ? 'opacity-45' : ''}
									{i > activeLineIndex ? 'opacity-30' : ''}"
							>
								{line.text}
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

			{#if isSynced || source === 'lrclib'}
				<div class="px-5 py-3 border-t border-base-content/10 flex justify-between gap-3 text-xs text-base-content/60">
					{#if isSynced}<span class="badge badge-xs badge-primary">Synced</span>{/if}
					{#if source === 'lrclib'}<span>Lyrics from LRCLIB</span>{/if}
				</div>
			{/if}
		</div>
	</div>
{/if}
