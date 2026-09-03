<script lang="ts">
	import { playerStore } from '$lib/stores/player.svelte';
	import { eqStore } from '$lib/stores/eq.svelte';
	import { scrobbleManager } from '$lib/stores/scrobble.svelte';
	import EqPanel from '$lib/components/EqPanel.svelte';
	import WordSyncedLyrics from '$lib/components/WordSyncedLyrics.svelte';
	import AudioQualityBadge from '$lib/components/AudioQualityBadge.svelte';
	import AlbumImage from '$lib/components/AlbumImage.svelte';
	import { openGlobalPlaylistModal } from '$lib/components/AddToPlaylistModal.svelte';
	import { karaokeController } from '$lib/stores/karaoke.svelte';
	import { slide } from 'svelte/transition';
	import { formatArtistCredit } from '$lib/utils/formatting';
	import type { CrateTrack, LocalAlbumSummary } from '$lib/types';
	import {
		Play,
		Pause,
		SkipBack,
		SkipForward,
		Shuffle,
		Disc3,
		Sparkles,
		Dices,
		ListMusic,
		ListPlus,
		Volume2,
		VolumeX,
		SlidersHorizontal,
		Music2,
		Maximize2,
		Check,
		CircleX,
		Mic
	} from 'lucide-svelte';

	interface Props {
		onDropPlay: (track: CrateTrack) => void;
		onDropAlbum: (album: LocalAlbumSummary) => void;
		onPlayAll: () => void;
		onShuffleAll: () => void;
		onSurprise: () => void;
		onOpenQueue: () => void;
	}

	let { onDropPlay, onDropAlbum, onPlayAll, onShuffleAll, onSurprise, onOpenQueue }: Props =
		$props();

	const np = $derived(playerStore.nowPlaying);
	const isLocal = $derived(np?.sourceType === 'local');
	const isPlaying = $derived(playerStore.isPlaying);
	const format = $derived(playerStore.currentQueueItem?.format ?? null);
	const isYouTube = $derived(np?.sourceType === 'youtube');
	const supportsLyrics = $derived(
		Boolean(np?.trackName?.trim() && formatArtistCredit(np?.artistName).trim())
	);
	const karaokeBusy = $derived(
		karaokeController.status === 'preparing' ||
			karaokeController.status === 'queued' ||
			karaokeController.status === 'processing'
	);

	function karaokeTip(): string {
		if (playerStore.karaokeActive) return 'Turn off karaoke';
		if (karaokeController.status === 'ready') return 'Karaoke ready';
		if (karaokeController.status === 'queued') return 'Karaoke is queued';
		if (karaokeController.status === 'processing') return 'Creating karaoke stems';
		if (karaokeController.status === 'failed') {
			return karaokeController.error || 'Karaoke unavailable';
		}
		if (karaokeController.status === 'idle') return 'Checking karaoke status…';
		return 'Karaoke not generated';
	}

	let dragOver = $state(false);
	let eqPanelOpen = $state(false);
	let lyricsOpen = $state(false);
	let karaokePanelOpen = $state(false);

	$effect(() => {
		karaokeController.syncTrack(np?.trackSourceId, np?.sourceType);
		if (!np) {
			lyricsOpen = false;
			return;
		}
		void np.trackSourceId;
		karaokePanelOpen = false;
	});

	function onVolume(e: Event) {
		playerStore.setVolume(Number((e.currentTarget as HTMLInputElement).value));
	}

	function addCurrentTrackToPlaylist() {
		const item = playerStore.currentQueueItem;
		if (!item || item.sourceType !== 'local') return;
		openGlobalPlaylistModal([item]);
	}

	function fmt(seconds: number): string {
		if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
		const m = Math.floor(seconds / 60);
		const s = Math.floor(seconds % 60);
		return `${m}:${s.toString().padStart(2, '0')}`;
	}

	const progressPct = $derived(
		playerStore.duration > 0 ? (playerStore.progress / playerStore.duration) * 100 : 0
	);

	function onSeek(e: Event) {
		const target = e.currentTarget as HTMLInputElement;
		const ratio = Number(target.value) / 1000;
		if (playerStore.duration > 0) playerStore.seekTo(ratio * playerStore.duration);
	}

	function openFullscreenLyrics() {
		if (!supportsLyrics) return;
		window.dispatchEvent(new CustomEvent('droppedneedle:open-lyrics'));
	}

	function readTrack(e: DragEvent): CrateTrack | null {
		const raw = e.dataTransfer?.getData('application/x-crate-track');
		if (!raw) return null;
		try {
			return JSON.parse(raw) as CrateTrack;
		} catch {
			return null;
		}
	}

	function readAlbum(e: DragEvent): LocalAlbumSummary | null {
		const raw = e.dataTransfer?.getData('application/x-crate-album');
		if (!raw) return null;
		try {
			return JSON.parse(raw) as LocalAlbumSummary;
		} catch {
			return null;
		}
	}

	function handleDragOver(e: DragEvent) {
		const types = e.dataTransfer?.types;
		if (
			types?.includes('application/x-crate-track') ||
			types?.includes('application/x-crate-album')
		) {
			e.preventDefault();
			dragOver = true;
		}
	}

	function handleDrop(e: DragEvent) {
		e.preventDefault();
		dragOver = false;
		const track = readTrack(e);
		if (track) {
			onDropPlay(track);
			return;
		}
		const album = readAlbum(e);
		if (album) onDropAlbum(album);
	}
</script>

<div
	class="deck-droptarget glass-surface relative flex flex-col items-center gap-6 rounded-3xl border border-base-content/5 p-6 sm:p-8"
	class:is-over={dragOver}
	role="region"
	aria-label="Now playing turntable - drop a track here to play it"
	ondragover={handleDragOver}
	ondragleave={() => (dragOver = false)}
	ondrop={handleDrop}
>
	<div
		data-listening-room-deck
		class="relative aspect-square w-full max-w-[32rem] lg:max-w-[36rem]"
	>
		{#if np && lyricsOpen}
			<div
				class="inline-lyrics-surface absolute inset-0 overflow-hidden rounded-3xl bg-transparent text-white"
			>
				<div class="absolute inset-0 z-10">
					{#key `${np.sourceType}:${np.trackSourceId}:${np.trackName}:${np.artistName}:${np.albumName}`}
						<WordSyncedLyrics
							title={np.trackName ?? ''}
							artist={formatArtistCredit(np.artistName)}
							album={np.albumName ?? ''}
							durationSeconds={np.duration ?? playerStore.duration}
							currentTimeSeconds={playerStore.progress}
							onseek={(seconds) => playerStore.seekTo(seconds)}
						/>
					{/key}
				</div>
			</div>
		{/if}
		{#if !lyricsOpen}
			<!-- Glow inset-0 must match the record's edge so the circles align. -->
			<div
				class="deck-halo absolute inset-0 -z-10 rounded-full"
				class:animate-glow-pulse={isPlaying}
			></div>
			<div
				class="turntable-platter vinyl-spin absolute inset-0 rounded-full"
				class:is-paused={!isPlaying}
			>
				<div
					class="pointer-events-none absolute inset-[9%] rounded-full border border-base-content/[0.06]"
				></div>
				<div
					class="pointer-events-none absolute inset-[18%] rounded-full border border-base-content/[0.07]"
				></div>
				<div
					class="pointer-events-none absolute inset-[27%] rounded-full border border-base-content/[0.08]"
				></div>
				<div
					class="absolute inset-[33.5%] overflow-hidden rounded-full ring-1 ring-base-content/25 shadow-[0_0_0_2px_oklch(from_var(--color-base-100)_l_c_h_/_0.55),0_2px_8px_oklch(from_var(--color-base-100)_l_c_h_/_0.6)]"
				>
					{#if np}
						<AlbumImage
							mbid={np.albumId}
							source={np.sourceType === 'local' ? 'local' : 'provider'}
							remoteUrl={np.coverRemoteUrl?.startsWith('http') ? np.coverRemoteUrl : null}
							customUrl={np.coverUrl}
							alt={np.albumName ?? 'Album'}
							size="full"
							requestSize={250}
							responsiveSizes="(max-width: 639px) 30vw, 190px"
							lazy={false}
							rounded="none"
							className="h-full w-full object-cover"
						/>
					{:else}
						<div class="flex h-full w-full items-center justify-center bg-base-300">
							<Disc3 class="h-8 w-8 text-base-content/30" />
						</div>
					{/if}
				</div>
				<div
					class="absolute inset-[48.5%] rounded-full bg-base-100 ring-1 ring-base-content/30"
				></div>
			</div>
			<div
				class="tonearm pointer-events-none absolute -right-1 -top-1 h-1/2 w-1/2"
				class:is-playing={isPlaying}
			>
				<div
					class="absolute right-[4.5%] top-[4.5%] h-4 w-4 rounded-full bg-base-300 ring-2 ring-base-content/20"
				></div>
				<div
					class="absolute right-[6.8%] top-[6.8%] h-1.5 w-[84%] origin-right rotate-[28deg] rounded-full bg-gradient-to-l from-base-content/40 to-base-content/15"
				>
					<div
						class="absolute -left-1 top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-sm bg-base-content/55 ring-1 ring-base-content/25"
					></div>
				</div>
			</div>
		{/if}
	</div>

	{#if np}
		<div class="flex w-full max-w-md flex-col items-center gap-1 text-center">
			<div class="flex items-center gap-2">
				{#if isPlaying}
					<div class="now-playing-bars now-playing-bars--sm">
						<span></span><span></span><span></span>
					</div>
				{/if}
				{#key np.trackSourceId}
					<p class="track-title-change truncate text-lg font-bold text-base-content">
						{np.trackName ?? np.albumName}
					</p>
				{/key}
			</div>
			{#key np.trackSourceId}
				<p class="track-title-change truncate text-sm text-base-content/70">
					{formatArtistCredit(np.artistName)}{#if np.albumName}<span class="text-base-content/40">
							&middot; {np.albumName}</span
						>{/if}
				</p>
			{/key}
		</div>

		<div class="flex w-full max-w-md items-center gap-3">
			<span class="w-10 text-right text-xs tabular-nums text-base-content/60"
				>{fmt(playerStore.progress)}</span
			>
			<input
				type="range"
				min="0"
				max="1000"
				value={Math.round(progressPct * 10)}
				oninput={onSeek}
				disabled={!playerStore.isSeekable}
				aria-label="Seek"
				class="range range-xs range-accent flex-1"
			/>
			<span class="w-10 text-xs tabular-nums text-base-content/60">{fmt(playerStore.duration)}</span
			>
		</div>

		<div class="flex items-center gap-2">
			<button
				class="btn btn-circle btn-ghost"
				class:opacity-30={!isLocal}
				class:cursor-not-allowed={!isLocal}
				onclick={addCurrentTrackToPlaylist}
				disabled={!isLocal}
				aria-label="Add current track to playlist"
				title={isLocal ? 'Add to playlist' : 'Only downloaded local tracks can be added'}
			>
				<ListPlus class="h-5 w-5" />
			</button>
			<button
				class="btn btn-circle btn-ghost"
				class:btn-active={playerStore.shuffleEnabled}
				onclick={() => playerStore.toggleShuffle()}
				aria-label="Shuffle"
			>
				<Shuffle class="h-5 w-5 {playerStore.shuffleEnabled ? 'text-accent' : ''}" />
			</button>
			<!-- Previous/next album controls are temporarily hidden.
			<div class="tooltip tooltip-top" data-tip="Previous album">
				<button
					class="btn btn-circle btn-ghost btn-sm"
					onclick={() => playerStore.previousAlbum()}
					disabled={!playerStore.hasPreviousAlbum}
					aria-label="Previous album"
				>
					<ChevronsLeft class="h-5 w-5" />
				</button>
			</div>
			-->
			<button
				class="btn btn-circle btn-ghost"
				onclick={() => playerStore.previousTrack()}
				disabled={!playerStore.hasPrevious}
				aria-label="Previous"
			>
				<SkipBack class="h-6 w-6" />
			</button>
			<button
				class="btn btn-circle btn-primary btn-lg shadow-lg"
				onclick={() => playerStore.togglePlay()}
				aria-label={isPlaying ? 'Pause' : 'Play'}
			>
				{#if isPlaying}<Pause class="h-7 w-7" />{:else}<Play class="h-7 w-7" />{/if}
			</button>
			<button
				class="btn btn-circle btn-ghost"
				onclick={() => playerStore.nextTrack()}
				disabled={!playerStore.hasNext}
				aria-label="Next"
			>
				<SkipForward class="h-6 w-6" />
			</button>
			<!--
			<div class="tooltip tooltip-top" data-tip="Next album">
				<button
					class="btn btn-circle btn-ghost btn-sm"
					onclick={() => playerStore.nextAlbum()}
					disabled={!playerStore.hasNextAlbum}
					aria-label="Next album"
				>
					<ChevronsRight class="h-5 w-5" />
				</button>
			</div>
			-->
			<div class="indicator">
				{#if playerStore.upcomingQueueLength > 0}
					<span class="badge indicator-item badge-xs badge-accent"
						>{playerStore.upcomingQueueLength}</span
					>
				{/if}
				<button class="btn btn-circle btn-ghost" onclick={onOpenQueue} aria-label="Open queue">
					<ListMusic class="h-5 w-5" />
				</button>
			</div>
			<div class="tooltip tooltip-top" data-tip="Lyrics">
				<button
					class="btn btn-circle btn-ghost"
					class:text-accent={lyricsOpen}
					onclick={() => (lyricsOpen = !lyricsOpen)}
					disabled={!supportsLyrics}
					aria-label="Toggle lyrics"
					aria-pressed={lyricsOpen}
				>
					<Music2 class="h-5 w-5" />
				</button>
			</div>
		</div>

		{#if isLocal && karaokePanelOpen}
			<div
				class="flex w-full max-w-md flex-wrap items-center justify-center gap-3 rounded-2xl border border-base-content/10 bg-base-100/35 px-3 py-2"
				transition:slide={{ duration: 220, axis: 'y' }}
			>
				<button
					class="btn btn-sm rounded-full {playerStore.karaokeActive ? 'btn-accent' : 'btn-ghost'}"
					disabled={karaokeBusy}
					onclick={() => void karaokeController.toggle()}
					aria-label={playerStore.karaokeActive ? 'Turn off karaoke' : 'Start karaoke'}
					title={karaokeTip()}
				>
					{#if karaokeBusy}
						<span class="loading loading-spinner loading-xs"></span>
					{:else}
						<Mic class="h-4 w-4" />
					{/if}
					{playerStore.karaokeActive
						? 'Karaoke on'
						: karaokeBusy
							? 'Creating stems...'
							: karaokeController.status === 'ready'
								? 'Karaoke ready'
								: 'Karaoke'}
				</button>
				{#if playerStore.karaokeActive}
					<div class="flex min-w-40 flex-1 items-center gap-2">
						<Mic class="h-4 w-4 shrink-0 text-accent" />
						<input
							type="range"
							min="0"
							max="100"
							value={playerStore.karaokeVocalLevel}
							oninput={(event) =>
								playerStore.setKaraokeVocalLevel(
									Number((event.currentTarget as HTMLInputElement).value)
								)}
							aria-label="Original vocal level"
							class="range range-xs range-accent flex-1"
						/>
						<span class="w-8 text-right text-[10px] tabular-nums text-base-content/60"
							>{Math.round(playerStore.karaokeVocalLevel)}%</span
						>
					</div>
				{:else if karaokeController.status === 'failed'}
					<span class="text-xs text-error">{karaokeController.error}</span>
				{/if}
			</div>
		{/if}

		<div class="flex w-full max-w-md items-center justify-between gap-4">
			<div class="flex min-w-0 items-center gap-2">
				{#if format}
					<AudioQualityBadge codec={format} />
				{/if}
				{#if scrobbleManager.enabled && scrobbleManager.status !== 'idle'}
					<div class="tooltip tooltip-top" data-tip={scrobbleManager.tooltip}>
						{#if scrobbleManager.status === 'scrobbled'}
							<Check class="h-4 w-4 text-success" />
						{:else if scrobbleManager.status === 'error'}
							<CircleX class="h-4 w-4 text-error" />
						{:else}
							<span class="badge badge-info badge-sm gap-1 font-semibold">
								<span class="status status-md status-info"></span>
								Tracking
							</span>
						{/if}
					</div>
				{/if}
			</div>
			<div class="flex shrink-0 items-center gap-2">
				<div class="flex items-center gap-1.5">
					{#if playerStore.volume === 0}
						<VolumeX class="h-4 w-4 shrink-0 opacity-60" />
					{:else}
						<Volume2 class="h-4 w-4 shrink-0 opacity-60" />
					{/if}
					<input
						type="range"
						min="0"
						max="100"
						value={playerStore.volume}
						oninput={onVolume}
						aria-label="Volume"
						class="range range-xs range-accent w-20 sm:w-24"
					/>
				</div>
				{#if isLocal}
					<div class="tooltip tooltip-top" data-tip={karaokeTip()}>
						<button
							class="btn btn-circle btn-ghost btn-sm"
							class:text-accent={karaokePanelOpen ||
								playerStore.karaokeActive ||
								karaokeController.status === 'ready' ||
								karaokeBusy}
							class:text-error={karaokeController.status === 'failed'}
							onclick={() => (karaokePanelOpen = !karaokePanelOpen)}
							aria-label={karaokePanelOpen ? 'Hide karaoke controls' : 'Show karaoke controls'}
							aria-expanded={karaokePanelOpen}
						>
							{#if karaokeBusy}
								<span class="loading loading-spinner loading-xs"></span>
							{:else}
								<Mic class="h-4 w-4" />
							{/if}
						</button>
					</div>
				{/if}
				<div
					class="tooltip tooltip-top"
					data-tip={isYouTube ? 'EQ unavailable for YouTube' : 'Equalizer'}
				>
					<button
						class="btn btn-circle btn-ghost btn-sm"
						class:text-accent={eqStore.enabled && !isYouTube}
						onclick={() => (eqPanelOpen = !eqPanelOpen)}
						disabled={isYouTube}
						aria-expanded={eqPanelOpen}
						aria-label="Toggle equalizer"
					>
						<SlidersHorizontal class="h-4 w-4" />
					</button>
				</div>
				<div
					class="tooltip tooltip-top"
					data-tip={supportsLyrics
						? 'Enter full screen lyrics'
						: 'Lyrics unavailable for this track'}
				>
					<button
						class="btn btn-circle btn-ghost btn-sm"
						class:opacity-30={!supportsLyrics}
						onclick={openFullscreenLyrics}
						disabled={!supportsLyrics}
						aria-label="Enter full screen lyrics"
					>
						<Maximize2 class="h-4 w-4" />
					</button>
				</div>
			</div>
		</div>

		{#if isLocal}
			<p class="text-[11px] uppercase tracking-wider text-base-content/30">
				drag a record onto the deck
			</p>
		{/if}
	{:else}
		<div class="flex w-full max-w-md flex-col items-center gap-4 text-center">
			<div>
				<p class="text-lg font-bold text-base-content">Drop the needle</p>
				<p class="text-sm text-base-content/60">
					Drag a record from the crate onto the deck, or just hit play.
				</p>
			</div>
			<div class="flex flex-wrap items-center justify-center gap-2">
				<button class="btn btn-primary btn-sm gap-2" onclick={onPlayAll}>
					<Play class="h-4 w-4" /> Play All
				</button>
				<button class="btn btn-ghost btn-sm gap-2" onclick={onShuffleAll}>
					<Shuffle class="h-4 w-4" /> Shuffle
				</button>
				<button class="btn btn-ghost btn-sm gap-2" onclick={onSurprise}>
					<Dices class="h-4 w-4" /> Surprise me
				</button>
			</div>
			<div
				class="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-base-content/30"
			>
				<Sparkles class="h-3 w-3" /> your library, ready to spin
			</div>
		</div>
	{/if}
</div>

<EqPanel bind:open={eqPanelOpen} onclose={() => (eqPanelOpen = false)} />

<style>
	.track-title-change {
		animation: track-title-change 760ms cubic-bezier(0.22, 1, 0.36, 1);
	}

	@keyframes track-title-change {
		from {
			opacity: 0;
			transform: translate3d(16px, 0, 0);
		}
		to {
			opacity: 1;
			transform: translate3d(0, 0, 0);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.track-title-change {
			animation: none;
		}
	}
</style>
