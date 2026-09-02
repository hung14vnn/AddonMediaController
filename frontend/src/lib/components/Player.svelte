<script lang="ts">
	import { fly } from 'svelte/transition';
	import { onMount } from 'svelte';
	import { playerStore } from '$lib/stores/player.svelte';
	import { deckFocus } from '$lib/stores/deckFocus.svelte';
	import { eqStore } from '$lib/stores/eq.svelte';
	import { scrobbleManager } from '$lib/stores/scrobble.svelte';
	import YouTubePlayer from '$lib/components/YouTubePlayer.svelte';
	import JellyfinIcon from '$lib/components/JellyfinIcon.svelte';
	import NavidromeIcon from '$lib/components/NavidromeIcon.svelte';
	import PlexIcon from '$lib/components/PlexIcon.svelte';
	import QueueDrawer from '$lib/components/QueueDrawer.svelte';
	import EqPanel from '$lib/components/EqPanel.svelte';
	import LyricsPanel from '$lib/components/LyricsPanel.svelte';
	import { openGlobalPlaylistModal } from '$lib/components/AddToPlaylistModal.svelte';
	import AudioQualityBadge from '$lib/components/AudioQualityBadge.svelte';
	import AlbumImage from '$lib/components/AlbumImage.svelte';
	import NowPlayingIndicator from '$lib/components/NowPlayingIndicator.svelte';
	import { getCoverUrl } from '$lib/utils/errorHandling';
	import { formatArtistCredit } from '$lib/utils/formatting';
	import { withBasePath } from '$lib/utils/basePath';
	import { getLyricsQuery } from '$lib/queries/lyrics/LyricsQuery.svelte';
	import { authStore } from '$lib/stores/authStore.svelte';
	import { karaokeController } from '$lib/stores/karaoke.svelte';
	import { getNavidromeFolderScopeRevision } from '$lib/utils/navidromeLibraryCache';
	import {
		X,
		ChevronDown,
		ChevronUp,
		Music,
		Disc3,
		Shuffle,
		SkipBack,
		AlertCircle,
		Pause,
		Play,
		SkipForward,
		Volume2,
		ExternalLink,
		Check,
		CircleX,
		ListMusic,
		ListPlus,
		SlidersHorizontal,
		Music2,
		Mic
	} from 'lucide-svelte';

	let eqPanelOpen = $state(false);
	let queueDrawerOpen = $state(false);
	let queuePinned = $state(false);

	let lyricsPanelOpen = $state(false);
	const karaokeStatus = $derived(karaokeController.status);
	const karaokeError = $derived(karaokeController.error);
	const lyricsQuery = getLyricsQuery(
		() => playerStore.nowPlaying,
		() => authStore.user?.id,
		() => getNavidromeFolderScopeRevision(authStore.user?.id ?? '')
	);

	const supportsLyrics = $derived(
		Boolean(playerStore.nowPlaying?.trackName?.trim() && playerStore.nowPlaying?.artistName?.trim())
	);

	$effect(() => {
		if (!playerStore.nowPlaying) lyricsPanelOpen = false;
	});

	onMount(() => {
		const handleOpenQueue = () => {
			queueDrawerOpen = true;
		};
		window.addEventListener('droppedneedle:open-queue', handleOpenQueue);
		return () => window.removeEventListener('droppedneedle:open-queue', handleOpenQueue);
	});

	$effect(() => {
		if (queuePinned) queueDrawerOpen = true;
	});

	function toggleQueueDrawer(): void {
		if (queuePinned) {
			queueDrawerOpen = true;
			return;
		}
		queueDrawerOpen = !queueDrawerOpen;
	}

	$effect(() => {
		karaokeController.syncTrack(playerStore.nowPlaying?.trackSourceId);
	});

	function toggleLyrics() {
		lyricsPanelOpen = !lyricsPanelOpen;
	}

	function formatTime(seconds: number): string {
		if (!seconds || isNaN(seconds)) return '0:00';
		const mins = Math.floor(seconds / 60);
		const secs = Math.floor(seconds % 60);
		return `${mins}:${secs.toString().padStart(2, '0')}`;
	}

	function handleSeek(e: Event): void {
		const target = e.target as HTMLInputElement;
		playerStore.seekTo(Number(target.value));
	}

	function handleVolume(e: Event): void {
		const target = e.target as HTMLInputElement;
		playerStore.setVolume(Number(target.value));
	}

	async function toggleKaraoke(): Promise<void> {
		if (!playerStore.karaokeActive) lyricsPanelOpen = true;
		await karaokeController.toggle();
	}

	const MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

	function isAlbumLinkable(id: string | undefined): boolean {
		return !!id && MBID_RE.test(id);
	}

	function openInYouTube(): void {
		const trackSourceId = playerStore.nowPlaying?.trackSourceId;
		if (trackSourceId) {
			window.open(`https://www.youtube.com/watch?v=${trackSourceId}`, '_blank');
		}
	}

	function addCurrentTrackToPlaylist(): void {
		const item = playerStore.currentQueueItem;
		if (!item || item.sourceType !== 'local') return;
		openGlobalPlaylistModal([item]);
	}

	const nowPlayingCoverUrl = $derived.by(() => {
		const np = playerStore.nowPlaying;
		if (!np) return null;
		if (np.sourceType === 'local' && np.coverUrl) return np.coverUrl;
		return getCoverUrl(np.coverUrl, np.albumId);
	});
</script>

{#if playerStore.isPlayerVisible && playerStore.nowPlaying && !deckFocus.inView}
	<div
		class="droppedneedle-player-bar fixed left-0 right-0 z-50 bg-base-300/95 backdrop-blur-md shadow-[0_-4px_20px_rgba(0,0,0,0.3)] transition-transform duration-300"
		transition:fly={{ y: 96, duration: 220 }}
	>
		<button
			class="btn btn-ghost btn-xs btn-circle absolute top-1.5 right-1.5 opacity-60 hover:opacity-100"
			onclick={() => playerStore.stop()}
			aria-label="Stop playback and close player"
		>
			<X class="h-3.5 w-3.5" />
		</button>
		<button
			class="btn btn-ghost btn-xs btn-circle absolute top-1.5 right-9 opacity-60 hover:opacity-100"
			onclick={() => playerStore.hidePlayer()}
			aria-label="Hide player"
			title="Hide player"
		>
			<ChevronDown class="h-3.5 w-3.5" />
		</button>

		<div
			class="droppedneedle-player-inner flex items-center gap-2 px-3 pr-9 sm:gap-4 sm:px-4 sm:pr-10 max-w-screen-2xl mx-auto"
		>
			<div class="flex min-w-0 flex-1 items-center gap-2 sm:gap-3 lg:w-1/4 lg:flex-none">
				{#key playerStore.nowPlaying.trackSourceId}
					<div class="track-change flex min-w-0 items-center gap-2 sm:gap-3">
						{#if nowPlayingCoverUrl}
							<a
								href="/library/local"
								class="shrink-0 rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
								aria-label="Open the Listening Room"
							>
								<AlbumImage
									mbid={playerStore.nowPlaying.albumId}
									source="local"
									customUrl={nowPlayingCoverUrl}
									available={true}
									alt={playerStore.nowPlaying.albumName}
									size="full"
									lazy={false}
									rounded="lg"
									className="w-12 h-12 sm:w-15 sm:h-15 shadow-lg ring-1 ring-base-content/10"
								/>
							</a>
						{:else}
							<a
								href="/library/local"
								class="w-12 h-12 sm:w-15 sm:h-15 rounded-lg shadow-lg bg-base-200 flex items-center justify-center shrink-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
								aria-label="Open the Listening Room"
							>
								<Disc3 class="h-6 w-6 text-base-content/20" />
							</a>
						{/if}
						<div class="min-w-0 pr-1">
							{#if playerStore.nowPlaying.trackName}
								<p class="text-sm font-semibold truncate">{playerStore.nowPlaying.trackName}</p>
								<p class="text-xs opacity-60 truncate">
									{#if isAlbumLinkable(playerStore.nowPlaying.albumId)}
										<a
											href={withBasePath(`/album/${playerStore.nowPlaying.albumId}`)}
											class="hover:underline">{playerStore.nowPlaying.albumName}</a
										>
									{:else}
										{playerStore.nowPlaying.albumName}
									{/if}
									-
									{#if playerStore.nowPlaying.artistId}
										<a
											href={withBasePath(`/artist/${playerStore.nowPlaying.artistId}`)}
											class="hover:underline"
											>{formatArtistCredit(playerStore.nowPlaying.artistName)}</a
										>
									{:else}
										{formatArtistCredit(playerStore.nowPlaying.artistName)}
									{/if}
								</p>
							{:else}
								<p class="text-sm font-semibold truncate">
									{#if isAlbumLinkable(playerStore.nowPlaying.albumId)}
										<a
											href={withBasePath(`/album/${playerStore.nowPlaying.albumId}`)}
											class="hover:underline">{playerStore.nowPlaying.albumName}</a
										>
									{:else}
										{playerStore.nowPlaying.albumName}
									{/if}
								</p>
								<p class="text-xs opacity-60 truncate">
									{#if playerStore.nowPlaying.artistId}
										<a
											href={withBasePath(`/artist/${playerStore.nowPlaying.artistId}`)}
											class="hover:underline"
											>{formatArtistCredit(playerStore.nowPlaying.artistName)}</a
										>
									{:else}
										{formatArtistCredit(playerStore.nowPlaying.artistName)}
									{/if}
								</p>
							{/if}
							{#if playerStore.hasQueue}
								<p class="text-xs opacity-40 truncate">
									Track {playerStore.currentTrackNumber} of {playerStore.queueLength}
								</p>
							{/if}
							{#if playerStore.nowPlaying.format}
								<AudioQualityBadge codec={playerStore.nowPlaying.format} compact />
							{/if}
							{#if playerStore.playbackState === 'error'}
								<p class="text-xs text-error truncate">This track isn't available right now.</p>
							{/if}
						</div>
					</div>
				{/key}
				{#if playerStore.isPlaying}
					<div class="hidden sm:block">
						<NowPlayingIndicator size="md" />
					</div>
				{/if}
			</div>

			<div class="flex shrink-0 flex-col items-center justify-center gap-1 sm:flex-1">
				<div class="flex items-center gap-1 sm:gap-3">
					{#if playerStore.hasQueue}
						<button
							class="btn btn-ghost btn-sm btn-circle hidden sm:inline-flex"
							class:opacity-30={playerStore.currentQueueItem?.sourceType !== 'local'}
							class:cursor-not-allowed={playerStore.currentQueueItem?.sourceType !== 'local'}
							onclick={addCurrentTrackToPlaylist}
							disabled={playerStore.currentQueueItem?.sourceType !== 'local'}
							aria-label="Add current track to playlist"
							title={playerStore.currentQueueItem?.sourceType === 'local'
								? 'Add to playlist'
								: 'Only downloaded local tracks can be added'}
						>
							<ListPlus class="h-4 w-4" />
						</button>
						<button
							class="btn btn-ghost btn-sm btn-circle hidden sm:inline-flex"
							class:text-accent={playerStore.shuffleEnabled}
							class:opacity-50={!playerStore.shuffleEnabled}
							onclick={() => playerStore.toggleShuffle()}
							aria-label="Toggle shuffle"
						>
							<Shuffle class="h-4 w-4" />
						</button>
					{/if}

					<button
						class="btn btn-ghost btn-sm btn-circle"
						class:opacity-30={!playerStore.hasPrevious}
						class:cursor-not-allowed={!playerStore.hasPrevious}
						disabled={!playerStore.hasPrevious}
						onclick={() => playerStore.previousTrack()}
						aria-label="Previous"
					>
						<SkipBack class="h-4 w-4 fill-current" />
					</button>

					<button
						class="btn btn-circle btn-accent shadow-md w-8 h-8"
						onclick={() =>
							playerStore.playbackState === 'error' ? playerStore.stop() : playerStore.togglePlay()}
						aria-label={playerStore.playbackState === 'error'
							? 'Close'
							: playerStore.isPlaying
								? 'Pause'
								: 'Play'}
					>
						{#if playerStore.playbackState === 'error'}
							<AlertCircle class="h-4 w-4" />
						{:else if playerStore.isBuffering}
							<span class="loading loading-spinner loading-sm"></span>
						{:else if playerStore.isPlaying}
							<Pause class="h-4 w-4 fill-current" />
						{:else}
							<Play class="h-4 w-4 ml-0.5 fill-current" />
						{/if}
					</button>

					<button
						class="btn btn-ghost btn-sm btn-circle"
						class:opacity-30={!playerStore.hasNext}
						class:cursor-not-allowed={!playerStore.hasNext}
						disabled={!playerStore.hasNext}
						onclick={() => playerStore.nextTrack()}
						aria-label="Next"
					>
						<SkipForward class="h-4 w-4 fill-current" />
					</button>

					<button
						class="btn btn-ghost btn-sm btn-circle md:hidden"
						class:text-accent={lyricsPanelOpen}
						onclick={toggleLyrics}
						disabled={!supportsLyrics}
						aria-label="Open lyrics"
					>
						<Music2 class="h-4 w-4" />
					</button>
				</div>

				<div class="hidden sm:flex items-center gap-2 w-full max-w-lg">
					<span class="text-xs opacity-60 w-10 text-right tabular-nums"
						>{formatTime(playerStore.progress)}</span
					>
					<input
						type="range"
						class="range range-xs range-accent flex-1"
						class:opacity-50={!playerStore.isSeekable}
						class:cursor-not-allowed={!playerStore.isSeekable}
						min="0"
						max={playerStore.duration || 1}
						value={playerStore.progress}
						disabled={!playerStore.isSeekable}
						oninput={handleSeek}
					/>
					<span class="text-xs opacity-60 w-10 tabular-nums"
						>{formatTime(playerStore.duration)}</span
					>
				</div>
				{#if !playerStore.isSeekable}
					<p class="hidden sm:block text-[10px] text-base-content/60">
						This stream doesn't support seeking.
					</p>
				{/if}
			</div>

			<div class="hidden md:flex items-center gap-3 lg:gap-7 lg:w-1/4 justify-end">
				<div class="tooltip tooltip-left" data-tip="Queue">
					<button
						class="btn btn-ghost btn-sm btn-circle relative"
						class:text-accent={queueDrawerOpen}
						onclick={toggleQueueDrawer}
						aria-label="Toggle queue"
					>
						<ListMusic class="h-4 w-4" />
						{#if playerStore.upcomingQueueLength > 0}
							<span class="badge badge-xs badge-accent absolute -top-1 -right-1"
								>{playerStore.upcomingQueueLength}</span
							>
						{/if}
					</button>
				</div>

				{#if playerStore.currentQueueItem?.sourceType === 'local'}
					<div
						class="tooltip tooltip-left"
						data-tip={playerStore.karaokeActive ? 'Turn off karaoke' : 'Karaoke'}
					>
						<button
							class="btn btn-ghost btn-sm btn-circle"
							class:text-accent={playerStore.karaokeActive ||
								karaokeStatus === 'processing' ||
								karaokeStatus === 'queued'}
							disabled={karaokeStatus === 'preparing' ||
								karaokeStatus === 'queued' ||
								karaokeStatus === 'processing'}
							onclick={toggleKaraoke}
							aria-label={playerStore.karaokeActive ? 'Turn off karaoke' : 'Start karaoke'}
						>
							{#if karaokeStatus === 'preparing' || karaokeStatus === 'queued' || karaokeStatus === 'processing'}
								<span class="loading loading-spinner loading-xs"></span>
							{:else}
								<Mic class="h-4 w-4" />
							{/if}
						</button>
					</div>
				{/if}

				<div
					class="tooltip tooltip-left"
					data-tip={supportsLyrics ? 'Lyrics' : 'Lyrics unavailable for this track'}
				>
					<button
						class="btn btn-ghost btn-sm btn-circle"
						class:text-accent={lyricsPanelOpen}
						onclick={toggleLyrics}
						disabled={!supportsLyrics}
						aria-label="Toggle lyrics"
					>
						<Music2 class="h-4 w-4" />
					</button>
				</div>

				<div
					class="tooltip tooltip-left"
					data-tip={playerStore.nowPlaying?.sourceType === 'youtube'
						? 'EQ unavailable for YouTube'
						: 'Equalizer'}
				>
					<button
						class="btn btn-ghost btn-sm btn-circle"
						class:text-accent={eqStore.enabled && playerStore.nowPlaying?.sourceType !== 'youtube'}
						class:opacity-30={playerStore.nowPlaying?.sourceType === 'youtube'}
						onclick={() => (eqPanelOpen = !eqPanelOpen)}
						aria-label="Toggle equalizer"
					>
						<SlidersHorizontal class="h-4 w-4" />
					</button>
				</div>

				<div class="hidden sm:flex items-center gap-1.5">
					<Volume2 class="h-4 w-4 opacity-60 shrink-0" />
					<input
						type="range"
						class="range range-xs w-20"
						min="0"
						max="100"
						value={playerStore.volume}
						oninput={handleVolume}
					/>
				</div>

				{#if scrobbleManager.enabled && scrobbleManager.status !== 'idle'}
					<div class="tooltip tooltip-left" data-tip={scrobbleManager.tooltip}>
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

				{#if playerStore.nowPlaying.sourceType === 'youtube'}
					<YouTubePlayer />

					<div class="tooltip tooltip-left" data-tip="Open in YouTube">
						<button
							class="btn btn-ghost btn-sm btn-circle"
							onclick={openInYouTube}
							aria-label="Open in YouTube"
						>
							<ExternalLink class="h-4 w-4" />
						</button>
					</div>
				{:else if playerStore.nowPlaying.sourceType === 'jellyfin'}
					<div class="hidden sm:flex items-center gap-2" style="color: rgb(var(--brand-jellyfin))">
						<JellyfinIcon class="h-5 w-5" />
						<span class="text-sm font-medium">Jellyfin</span>
					</div>
				{:else if playerStore.nowPlaying.sourceType === 'navidrome'}
					<div class="hidden sm:flex items-center gap-2" style="color: rgb(var(--brand-navidrome))">
						<NavidromeIcon class="h-5 w-5" />
						<span class="text-sm font-medium">Navidrome</span>
					</div>
				{:else if playerStore.nowPlaying.sourceType === 'plex'}
					<div class="hidden sm:flex items-center gap-2" style="color: rgb(var(--brand-plex))">
						<PlexIcon class="h-5 w-5" />
						<span class="text-sm font-medium">Plex</span>
					</div>
				{:else if playerStore.nowPlaying.sourceType === 'local'}
					<div
						class="hidden sm:flex items-center gap-2"
						style="color: rgb(var(--brand-localfiles))"
					>
						<Music class="h-5 w-5" />
						<span class="text-sm font-medium">Local</span>
					</div>
				{/if}
			</div>
		</div>
	</div>

	<EqPanel bind:open={eqPanelOpen} onclose={() => (eqPanelOpen = false)} />
	<LyricsPanel
		bind:open={lyricsPanelOpen}
		lyricsText={lyricsQuery.data?.text ?? ''}
		lines={lyricsQuery.data?.lines ?? []}
		isSynced={lyricsQuery.data?.is_synced ?? false}
		onseek={(seconds) => playerStore.seekTo(seconds)}
		isPlaying={playerStore.isPlaying}
		hasPrevious={playerStore.hasPrevious}
		hasNext={playerStore.hasNext}
		ontoggleplay={() => playerStore.togglePlay()}
		onprevious={() => playerStore.previousTrack()}
		onnext={() => playerStore.nextTrack()}
		onopenqueue={toggleQueueDrawer}
		isLoading={lyricsQuery.isFetching}
		hasError={lyricsQuery.isError}
		currentTime={playerStore.progress}
		trackName={playerStore.nowPlaying?.trackName ?? ''}
		artistName={formatArtistCredit(playerStore.nowPlaying?.artistName)}
		albumName={playerStore.nowPlaying?.albumName ?? ''}
		trackKey={`${playerStore.nowPlaying?.sourceType ?? ''}:${playerStore.nowPlaying?.trackSourceId ?? ''}:${playerStore.nowPlaying?.trackName ?? ''}:${playerStore.nowPlaying?.artistName ?? ''}:${playerStore.nowPlaying?.albumName ?? ''}`}
		coverUrl={nowPlayingCoverUrl}
		duration={playerStore.nowPlaying?.duration ?? playerStore.duration}
		onclose={() => (lyricsPanelOpen = false)}
		{karaokeStatus}
		karaokeAvailable={playerStore.currentQueueItem?.sourceType === 'local'}
		karaokeActive={playerStore.karaokeActive}
		{karaokeError}
		vocalLevel={playerStore.karaokeVocalLevel}
		ontogglekaraoke={toggleKaraoke}
		onvocalchange={(level) => playerStore.setKaraokeVocalLevel(level)}
	/>
{/if}

<QueueDrawer
	bind:open={queueDrawerOpen}
	bind:pinned={queuePinned}
	pinnable
	onclose={() => (queueDrawerOpen = false)}
/>

{#if playerStore.nowPlaying && !playerStore.isPlayerVisible && !deckFocus.inView}
	<button
		class="fixed bottom-[calc(var(--ms-bottom-nav-offset)+1rem)] right-4 z-[70] btn btn-sm btn-primary gap-1.5 shadow-lg"
		onclick={() => playerStore.showPlayer()}
		aria-label="Show player"
	>
		<ChevronUp class="h-4 w-4" />
		<span class="hidden sm:inline">Show player</span>
	</button>
{/if}

<style>
	.track-change {
		animation: track-change 760ms cubic-bezier(0.22, 1, 0.36, 1);
	}

	@keyframes track-change {
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
		.track-change {
			animation: none;
		}
	}
</style>
