import type {
	PlaybackSource,
	PlaybackState,
	NowPlaying,
	QueueItem,
	SourceType
} from '$lib/player/types';
import { createPlaybackSource } from '$lib/player/createSource';
import { API } from '$lib/constants';
import { api } from '$lib/api/client';
import {
	reportProgress as reportJellyfinProgress,
	reportStop as reportJellyfinStop,
	startSession as startJellyfinSession
} from '$lib/player/jellyfinPlaybackApi';
import {
	reportNavidromeScrobble,
	reportNavidromeNowPlaying,
	reportNavidromeStopped
} from '$lib/player/navidromePlaybackApi';
import {
	reportPlexScrobble,
	reportPlexNowPlaying,
	reportPlexStopped
} from '$lib/player/plexPlaybackApi';
import { playbackToast } from '$lib/stores/playbackToast.svelte';
import { radioSession } from '$lib/stores/radioSession.svelte';
import {
	getStoredVolume,
	storeVolume,
	storeSessionData,
	stampOrigin,
	stampSingleOrigin,
	showQueueMutationToast,
	type StoredSession
} from './playerUtils';
import { createProgressReporter, createBeforeUnloadHandler } from './playerJellyfinReporting';
import {
	computeNextIndex,
	computePreviousIndex,
	computeUpcomingLength,
	computeNextAlbumIndex,
	computePreviousAlbumIndex,
	queueHasAlbums,
	performCleanup
} from './playerQueueOps';
import {
	resolveSourceUrl,
	buildPrefetchUrl,
	buildNowPlayingMetadata
} from './playerSourceResolver';
import { resumeAudioEngine } from '$lib/player/audioElement';
import { createOfflineTrackUrl } from '$lib/offline/offlineAudio';
import { authStore } from '$lib/stores/authStore.svelte';
import { KaraokePlaybackSource } from '$lib/player/KaraokePlaybackSource';
import {
	setMediaSessionActionHandler,
	updateMediaSessionMetadata,
	updateMediaSessionPlaybackState,
	updateMediaSessionPosition
} from '$lib/player/mediaSession';
import {
	persistSession as doPersistSession,
	restoreSessionData,
	buildResumeState
} from './playerSessionManager';
import {
	addItemToQueue,
	addMultipleItems,
	insertPlayNext,
	insertMultipleNext,
	removeAtIndex,
	performReorder,
	performShuffleReorder,
	clearQueueKeepCurrent
} from './playerQueueMethods';
import {
	buildPlayQueueState,
	computeToggleShuffle,
	changeItemSource,
	updateItemByPlaylistTrackId
} from './playerPlaybackMethods';

const MAX_CONSECUTIVE_ERRORS = 3;
const PREVIEW_FADE_S = 2;
const ERROR_SKIP_DELAY_MS = 2000;
const MAX_HISTORY_LENGTH = 3;
const SESSION_PERSIST_INTERVAL_MS = 5000;
const JELLYFIN_REPORT_INTERVAL_MS = 10_000;
const MAX_JELLYFIN_REPORT_FAILURES = 3;

function createPlayerStore() {
	let currentSource = $state<PlaybackSource | null>(null);
	let nowPlaying = $state<NowPlaying | null>(null);
	let playbackState = $state<PlaybackState>('idle');
	let isSeekable = $state(true);
	let volume = $state(getStoredVolume());
	let progress = $state(0);
	let duration = $state(0);
	let isPlayerVisible = $state(false);
	let karaokeActive = $state(false);
	let karaokeVocalLevel = $state(100);
	let loadGeneration = 0;
	let queue = $state<QueueItem[]>([]);
	let currentIndex = $state(0);
	let shuffleEnabled = $state(false);
	let shuffleOrder = $state<number[]>([]);
	let consecutiveErrors = 0;
	let failedTrackNames: string[] = [];
	let errorSkipTimeout: ReturnType<typeof setTimeout> | null = null;
	let lastPersistTime = 0;
	let beforeUnloadRegistered = false;

	const isPlaying = $derived(playbackState === 'playing');
	const isBuffering = $derived(playbackState === 'buffering' || playbackState === 'loading');
	const hasQueue = $derived(queue.length > 0);
	const hasNext = $derived.by(() => {
		if (queue.length <= 1) return false;
		if (shuffleEnabled) {
			const si = shuffleOrder.indexOf(currentIndex);
			return si < shuffleOrder.length - 1;
		}
		return currentIndex < queue.length - 1;
	});
	const hasPrevious = $derived.by(() => {
		if (queue.length <= 1) return false;
		if (shuffleEnabled) {
			const si = shuffleOrder.indexOf(currentIndex);
			return si > 0;
		}
		return currentIndex > 0;
	});
	const currentQueueItem = $derived(queue.length > 0 ? queue[currentIndex] : null);
	const queueLength = $derived(queue.length);
	// Album-skip is disabled under shuffle, which has no album boundaries.
	const hasAlbumsInQueue = $derived(queueHasAlbums(queue));
	const hasNextAlbum = $derived(
		!shuffleEnabled && hasAlbumsInQueue && computeNextAlbumIndex(queue, currentIndex) !== null
	);
	const hasPreviousAlbum = $derived(
		!shuffleEnabled && hasAlbumsInQueue && computePreviousAlbumIndex(queue, currentIndex) !== null
	);
	const currentTrackNumber = $derived(
		shuffleEnabled && shuffleOrder.length > 0
			? shuffleOrder.indexOf(currentIndex) + 1 || currentIndex + 1
			: currentIndex + 1
	);

	const progressReporter = createProgressReporter(
		reportJellyfinProgress,
		JELLYFIN_REPORT_INTERVAL_MS,
		MAX_JELLYFIN_REPORT_FAILURES
	);
	const handleBeforeUnload = createBeforeUnloadHandler(
		() => ({ jellyfinItem: getJellyfinItem(), currentItem: queue[currentIndex] ?? null, progress }),
		API.stream.jellyfinStop,
		API.stream.navidromeScrobble,
		API.stream.plexScrobble
	);

	function getNextIndex(): number | null {
		return computeNextIndex(currentIndex, queue.length, shuffleEnabled, shuffleOrder);
	}
	function getPreviousIndex(): number | null {
		return computePreviousIndex(currentIndex, queue.length, shuffleEnabled, shuffleOrder);
	}
	function getJellyfinItem(): QueueItem | null {
		const item = queue[currentIndex];
		return item?.sourceType === 'jellyfin' ? item : null;
	}
	function getCurrentItem(): QueueItem | null {
		return queue[currentIndex] ?? null;
	}
	function persist(): void {
		doPersistSession(nowPlaying, queue, currentIndex, progress, shuffleEnabled, shuffleOrder);
	}

	function registerBeforeUnload(): void {
		if (beforeUnloadRegistered || typeof window === 'undefined') return;
		window.addEventListener('beforeunload', handleBeforeUnload);
		beforeUnloadRegistered = true;
	}
	function unregisterBeforeUnload(): void {
		if (!beforeUnloadRegistered || typeof window === 'undefined') return;
		window.removeEventListener('beforeunload', handleBeforeUnload);
		beforeUnloadRegistered = false;
	}
	async function stopPreviousSession(item: QueueItem | null, posSeconds: number): Promise<void> {
		progressReporter.stop();
		unregisterBeforeUnload();
		if (!item) return;
		if (item.sourceType === 'jellyfin' && item.playSessionId) {
			await reportJellyfinStop(item.trackSourceId, item.playSessionId, posSeconds);
		} else if (item.sourceType === 'navidrome') {
			void reportNavidromeStopped(item.trackSourceId);
		} else if (item.sourceType === 'plex' && item.plexRatingKey) {
			void reportPlexStopped(item.plexRatingKey);
		}
	}

	function applyResetState(): void {
		radioSession.end();
		currentSource?.destroy();
		currentSource = null;
		nowPlaying = null;
		updateMediaSessionMetadata(null);
		updateMediaSessionPlaybackState('none');
		setMediaSessionActionHandler('play', null);
		setMediaSessionActionHandler('pause', null);
		setMediaSessionActionHandler('seekbackward', null);
		setMediaSessionActionHandler('seekforward', null);
		setMediaSessionActionHandler('seekto', null);
		setMediaSessionActionHandler('nexttrack', null);
		setMediaSessionActionHandler('previoustrack', null);
		playbackState = 'idle';
		isSeekable = true;
		isPlayerVisible = false;
		karaokeActive = false;
		progress = 0;
		duration = 0;
		queue = [];
		currentIndex = 0;
		shuffleOrder = [];
		shuffleEnabled = false;
		consecutiveErrors = 0;
		failedTrackNames = [];
		progressReporter.stop();
		unregisterBeforeUnload();
		storeSessionData(null);
	}

	async function resolveSourceForItem(item: QueueItem): Promise<{
		source: PlaybackSource;
		loadUrl: string | undefined;
	}> {
		const url = resolveSourceUrl(item);
		if (item.sourceType === 'youtube') {
			isSeekable = true;
			return { source: createPlaybackSource('youtube'), loadUrl: url };
		}
		if (item.sourceType === 'local') {
			const offline = authStore.user?.id
				? await createOfflineTrackUrl(authStore.user.id, item.trackSourceId)
				: null;
			const playbackUrl = offline?.url ?? url;
			isSeekable = true;
			return {
				source: createPlaybackSource('local', {
					url: playbackUrl!,
					seekable: true,
					cleanup: offline?.revoke
				}),
				loadUrl: playbackUrl
			};
		}
		if (item.sourceType === 'navidrome') {
			isSeekable = true;
			void reportNavidromeNowPlaying(item.trackSourceId);
			return {
				source: createPlaybackSource('navidrome', { url: url!, seekable: true }),
				loadUrl: url
			};
		}
		if (item.sourceType === 'plex') {
			isSeekable = true;
			if (item.plexRatingKey) void reportPlexNowPlaying(item.plexRatingKey);
			return {
				source: createPlaybackSource('plex', { url: url!, seekable: true }),
				loadUrl: url
			};
		}
		isSeekable = true;
		return {
			source: createPlaybackSource('jellyfin', { url: url!, seekable: true }),
			loadUrl: url
		};
	}

	async function startJellyfinPlayback(index: number): Promise<void> {
		const item = queue[index];
		if (!item || item.sourceType !== 'jellyfin') return;
		try {
			const playSessionId = await startJellyfinSession(item.trackSourceId, item.playSessionId);
			const uq = [...queue];
			uq[index] = { ...uq[index], playSessionId };
			queue = uq;
			registerBeforeUnload();
		} catch {
			const uq = [...queue];
			uq[index] = { ...uq[index], playSessionId: '' };
			queue = uq;
		}
	}

	async function loadQueueItem(index: number): Promise<void> {
		const item = queue[index];
		if (!item) return;
		if (errorSkipTimeout) {
			clearTimeout(errorSkipTimeout);
			errorSkipTimeout = null;
		}
		const prevProgress = progress,
			prevItem = currentSource ? (queue[currentIndex] ?? null) : null;
		currentIndex = index;
		updateMediaSessionControls();
		playbackState = 'loading';
		progress = 0;
		duration = 0;
		if (prevItem) {
			await stopPreviousSession(prevItem, prevProgress);
		} else {
			progressReporter.stop();
			unregisterBeforeUnload();
		}
		currentSource?.destroy();
		karaokeActive = false;
		const gen = ++loadGeneration;
		let source: PlaybackSource,
			resolvedUrl: string | undefined = item.streamUrl;
		try {
			const r = await resolveSourceForItem(item);
			if (gen !== loadGeneration) {
				r.source.destroy();
				return;
			}
			source = r.source;
			resolvedUrl = r.loadUrl;
		} catch {
			if (gen === loadGeneration) handleTrackError(gen);
			return;
		}
		currentSource = source;
		nowPlaying = buildNowPlayingMetadata(queue[index] ?? item);
		updateMediaSessionMetadata(nowPlaying);
		persist();
		subscribeToSource(source, gen);
		source.setVolume(volume);
		try {
			const activeItem = queue[index] ?? item;
			const loadPromise = source.load({
				trackSourceId: activeItem.trackSourceId,
				url: resolvedUrl,
				format: activeItem.format
			});
			// Session must exist before play(): a fast 'playing' event would otherwise
			// start the progress reporter without a playSessionId and it bails permanently.
			if (activeItem.sourceType === 'jellyfin') await startJellyfinPlayback(index);
			if (gen === loadGeneration && activeItem.sourceType !== 'youtube') {
				source.play();
			}
			await loadPromise;
			if (gen === loadGeneration && activeItem.sourceType === 'youtube') {
				source.play();
			}
		} catch {
			if (gen === loadGeneration) handleTrackError(gen);
		}
	}

	function handleTrackError(gen: number): void {
		if (gen !== loadGeneration) return;
		consecutiveErrors++;
		playbackState = 'error';
		const trackName = nowPlaying?.trackName ?? 'Unknown track';
		failedTrackNames.push(trackName);
		if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
			const named = failedTrackNames
				.slice(0, MAX_CONSECUTIVE_ERRORS)
				.map((n) => `"${n}"`)
				.join(', ');
			const extra = failedTrackNames.length - MAX_CONSECUTIVE_ERRORS;
			const suffix = extra > 0 ? ` +${extra} more` : '';
			playbackToast.show(`Several tracks failed: ${named}${suffix} - playback stopped.`, 'error');
			applyResetState();
			return;
		}
		const nextIdx = getNextIndex();
		if (nextIdx !== null) {
			playbackToast.show(`"${trackName}" is unavailable, skipping...`, 'warning');
			errorSkipTimeout = setTimeout(() => {
				errorSkipTimeout = null;
				if (gen === loadGeneration) void loadQueueItem(nextIdx);
			}, ERROR_SKIP_DELAY_MS);
		} else {
			playbackToast.show(`"${trackName}" unavailable`, 'error');
		}
	}

	function prefetchNext(): void {
		const nextIdx = getNextIndex();
		if (nextIdx === null) return;
		const nextItem = queue[nextIdx];
		if (!nextItem) return;
		const url = buildPrefetchUrl(nextItem);
		if (url) void api.global.head(url).catch(() => {});
	}

	function updateMediaSessionControls(): void {
		setMediaSessionActionHandler('play', playCurrent);
		setMediaSessionActionHandler('pause', pauseCurrent);
		// Keep the OS/mobile media controls focused on queue navigation. Registering
		// seekbackward/seekforward makes Android and iOS surface +/-10s buttons in
		// place of the previous/next track actions.
		setMediaSessionActionHandler('seekbackward', null);
		setMediaSessionActionHandler('seekforward', null);
		setMediaSessionActionHandler('seekto', ({ seekTime }) => {
			if (seekTime !== undefined) seekCurrent(seekTime);
		});
		setMediaSessionActionHandler('nexttrack', getNextIndex() === null ? null : nextTrack);
		setMediaSessionActionHandler(
			'previoustrack',
			getPreviousIndex() === null ? null : previousTrack
		);
	}

	function playCurrent(): void {
		// Native sources resume the optional Web Audio graph immediately before
		// calling HTMLMediaElement.play(). YouTube is iframe-backed and must not
		// create an unused AudioContext at all.
		const sourceType = currentQueueItem?.sourceType ?? nowPlaying?.sourceType;
		if (sourceType !== 'youtube') void resumeAudioEngine();
		currentSource?.play();
	}

	function pauseCurrent(): void {
		currentSource?.pause();
		const jf = getJellyfinItem();
		if (jf?.playSessionId)
			void reportJellyfinProgress(jf.trackSourceId, jf.playSessionId, progress, true);
		const item = getCurrentItem();
		if (item?.sourceType === 'plex' && item.plexRatingKey)
			void reportPlexStopped(item.plexRatingKey);
		if (item?.sourceType === 'navidrome') void reportNavidromeStopped(item.trackSourceId);
		persist();
	}

	function seekCurrent(seconds: number): void {
		if (!isSeekable) return;
		const target = duration > 0 ? Math.max(0, Math.min(seconds, duration)) : Math.max(0, seconds);
		currentSource?.seekTo(target);
		progress = target;
		updateMediaSessionPosition(progress, duration);
		persist();
	}

	function nextTrack(): void {
		const idx = getNextIndex();
		if (idx !== null)
			void loadQueueItem(idx).then(() => {
				const c = performCleanup(
					queue,
					currentIndex,
					shuffleEnabled,
					shuffleOrder,
					MAX_HISTORY_LENGTH
				);
				queue = c.newQueue;
				currentIndex = c.newIndex;
				shuffleOrder = c.newShuffleOrder;
				persist();
			});
	}

	function previousTrack(): void {
		const idx = getPreviousIndex();
		if (idx !== null) void loadQueueItem(idx);
	}

	function subscribeToSource(source: PlaybackSource, gen: number): void {
		source.onStateChange((state) => {
			if (gen !== loadGeneration) return;
			playbackState = state;
			if (state === 'playing') updateMediaSessionPlaybackState('playing');
			else if (state === 'paused' || state === 'buffering' || state === 'loading')
				updateMediaSessionPlaybackState('paused');
			else updateMediaSessionPlaybackState('none');
			if (state === 'playing') {
				consecutiveErrors = 0;
				failedTrackNames = [];
				if (getJellyfinItem())
					progressReporter.start(() => ({
						jellyfinItem: getJellyfinItem(),
						progress,
						isPaused: playbackState !== 'playing'
					}));
				prefetchNext();
			}
			if (state === 'paused') {
				const jf = getJellyfinItem();
				if (jf?.playSessionId)
					void reportJellyfinProgress(jf.trackSourceId, jf.playSessionId, progress, true);
			}
			if (state === 'ended') {
				const endedItem = getCurrentItem();
				void stopPreviousSession(endedItem, progress);
				if (endedItem?.sourceType === 'plex' && endedItem.plexRatingKey)
					void reportPlexScrobble(endedItem.plexRatingKey);
				else if (endedItem?.sourceType === 'navidrome')
					void reportNavidromeScrobble(endedItem.trackSourceId);
				const nextIdx = getNextIndex();
				if (nextIdx !== null) {
					void loadQueueItem(nextIdx).then(() => {
						const c = performCleanup(
							queue,
							currentIndex,
							shuffleEnabled,
							shuffleOrder,
							MAX_HISTORY_LENGTH
						);
						queue = c.newQueue;
						currentIndex = c.newIndex;
						shuffleOrder = c.newShuffleOrder;
						persist();
					});
				} else {
					applyResetState();
				}
			}
		});
		source.onProgress((t, d) => {
			if (gen !== loadGeneration) return;
			progress = t;
			duration = d;
			// Do not publish MediaSession position on every native `timeupdate`.
			// iOS fires this event several times per second, and each
			// setPositionState call crosses into WebKit's media-session bridge.
			// The native audio element already keeps the lock-screen timeline in
			// sync; explicit updates are sent only after a user seek.
			// preview tier: DJ-style fade over the last 2s so 30s clips blend
			// instead of stopping dead (owner-signed anti-jarring rule)
			const item = queue[currentIndex];
			if (item?.isPreview && d > 0) {
				const remaining = d - t;
				if (remaining <= PREVIEW_FADE_S && remaining >= 0) {
					source.setVolume(volume * Math.max(0, remaining / PREVIEW_FADE_S));
				}
			}
			const now = Date.now();
			if (now - lastPersistTime >= SESSION_PERSIST_INTERVAL_MS) {
				lastPersistTime = now;
				persist();
			}
		});
		source.onError(() => {
			if (gen !== loadGeneration) return;
			handleTrackError(gen);
		});
	}

	async function replaceCurrentSource(
		source: PlaybackSource,
		startAt: number,
		resume: boolean
	): Promise<void> {
		currentSource?.pause();
		currentSource?.destroy();
		const gen = ++loadGeneration;
		currentSource = source;
		playbackState = 'loading';
		source.setVolume(volume);
		await source.load({});
		if (gen !== loadGeneration) {
			source.destroy();
			throw new Error('Playback changed while the new source was loading');
		}
		subscribeToSource(source, gen);
		source.seekTo(startAt);
		progress = startAt;
		if (resume) source.play();
		else playbackState = 'paused';
	}

	async function restoreOriginalSource(startAt: number, resume: boolean): Promise<void> {
		const item = queue[currentIndex];
		if (!item) throw new Error('Current queue item is unavailable');
		const resolved = await resolveSourceForItem(item);
		await replaceCurrentSource(resolved.source, startAt, resume);
	}

	return {
		get currentSource() {
			return currentSource;
		},
		get nowPlaying() {
			return nowPlaying;
		},
		get playbackState() {
			return playbackState;
		},
		get isPlaying() {
			return isPlaying;
		},
		get isBuffering() {
			return isBuffering;
		},
		get isSeekable() {
			return isSeekable;
		},
		get volume() {
			return volume;
		},
		get progress() {
			return progress;
		},
		get duration() {
			return duration;
		},
		get isPlayerVisible() {
			return isPlayerVisible;
		},
		get karaokeActive() {
			return karaokeActive;
		},
		get karaokeVocalLevel() {
			return karaokeVocalLevel;
		},
		get hasQueue() {
			return hasQueue;
		},
		get hasNext() {
			return hasNext;
		},
		get hasPrevious() {
			return hasPrevious;
		},
		get hasNextAlbum() {
			return hasNextAlbum;
		},
		get hasPreviousAlbum() {
			return hasPreviousAlbum;
		},
		get shuffleEnabled() {
			return shuffleEnabled;
		},
		get queue() {
			return queue;
		},
		get currentIndex() {
			return currentIndex;
		},
		get currentQueueItem() {
			return currentQueueItem;
		},
		get queueLength() {
			return queueLength;
		},
		get upcomingQueueLength() {
			return computeUpcomingLength(queue.length, currentIndex, shuffleEnabled, shuffleOrder);
		},
		get currentTrackNumber() {
			return currentTrackNumber;
		},
		get shuffleOrder() {
			return shuffleOrder;
		},

		playAlbum(source: PlaybackSource, metadata: NowPlaying): void {
			radioSession.end();
			void stopPreviousSession(getCurrentItem(), progress);
			currentSource?.destroy();
			const gen = ++loadGeneration;
			currentSource = source;
			nowPlaying = metadata;
			updateMediaSessionMetadata(nowPlaying);
			updateMediaSessionPlaybackState('paused');
			playbackState = 'loading';
			isSeekable = true;
			isPlayerVisible = true;
			karaokeActive = false;
			queue = [];
			currentIndex = 0;
			shuffleOrder = [];
			consecutiveErrors = 0;
			subscribeToSource(source, gen);
			updateMediaSessionControls();
			source.setVolume(volume);
			persist();
		},

		playQueue(items: QueueItem[], startIndex: number = 0, shuffle: boolean = false): void {
			if (items.length === 0) return;
			if (!items.some((item) => item.playlistTrackId?.startsWith('radio:'))) {
				radioSession.end();
			}
			const currentItem = queue[currentIndex];
			const matchingCurrentIndex =
				shuffle && currentItem?.playlistTrackId
					? items.findIndex((item) => item.playlistTrackId === currentItem.playlistTrackId)
					: -1;
			const s = buildPlayQueueState(
				items,
				matchingCurrentIndex >= 0 ? matchingCurrentIndex : startIndex,
				shuffle,
				matchingCurrentIndex >= 0
			);
			queue = s.queue;
			shuffleEnabled = s.shuffleEnabled;
			shuffleOrder = s.shuffleOrder;
			isPlayerVisible = s.isPlayerVisible;
			consecutiveErrors = 0;
			if (matchingCurrentIndex >= 0) {
				// Reordering a queue around the track that is already playing must not
				// reload it, otherwise shuffle restarts the current song from 0:00.
				currentIndex = s.startIndex;
				updateMediaSessionControls();
				persist();
				return;
			}
			void loadQueueItem(s.startIndex);
		},

		nextTrack,

		previousTrack,

		nextAlbum(): void {
			if (!hasNextAlbum) return;
			const idx = computeNextAlbumIndex(queue, currentIndex);
			if (idx !== null)
				void loadQueueItem(idx).then(() => {
					const c = performCleanup(
						queue,
						currentIndex,
						shuffleEnabled,
						shuffleOrder,
						MAX_HISTORY_LENGTH
					);
					queue = c.newQueue;
					currentIndex = c.newIndex;
					shuffleOrder = c.newShuffleOrder;
					persist();
				});
		},

		previousAlbum(): void {
			if (!hasPreviousAlbum) return;
			const idx = computePreviousAlbumIndex(queue, currentIndex);
			if (idx !== null) void loadQueueItem(idx);
		},

		toggleShuffle(): void {
			const r = computeToggleShuffle(queue.length, currentIndex, shuffleEnabled);
			shuffleEnabled = r.shuffleEnabled;
			shuffleOrder = r.shuffleOrder;
		},

		jumpToTrack(index: number): void {
			if (index >= 0 && index < queue.length) void loadQueueItem(index);
		},

		addToQueue(item: QueueItem): void {
			if (queue.length === 0) {
				this.playQueue([stampSingleOrigin(item, 'manual')], 0, false);
				showQueueMutationToast('queue', 1);
				return;
			}
			const r = addItemToQueue(queue, item, shuffleEnabled, shuffleOrder);
			queue = r.newQueue;
			shuffleOrder = r.newShuffleOrder;
			persist();
			showQueueMutationToast('queue', 1);
		},

		addMultipleToQueue(items: QueueItem[]): void {
			if (items.length === 0) return;
			if (queue.length === 0) {
				this.playQueue(stampOrigin(items, 'manual'), 0, false);
				showQueueMutationToast('queue', items.length);
				return;
			}
			const r = addMultipleItems(queue, items, shuffleEnabled, shuffleOrder);
			queue = r.newQueue;
			shuffleOrder = r.newShuffleOrder;
			persist();
			showQueueMutationToast('queue', items.length);
		},

		appendQueueSilent(items: QueueItem[]): void {
			if (items.length === 0) return;
			const r = addMultipleItems(queue, items, shuffleEnabled, shuffleOrder);
			queue = r.newQueue;
			shuffleOrder = r.newShuffleOrder;
			persist();
		},

		regenerateShuffleOrder(): void {
			if (!shuffleEnabled || queue.length === 0) return;

			// Find current position in shuffle order (not raw queue index)
			const currentShufflePos = shuffleOrder.indexOf(currentIndex);

			// Keep everything up to and including current position (played + now playing)
			const kept =
				currentShufflePos >= 0 ? shuffleOrder.slice(0, currentShufflePos + 1) : [currentIndex];
			const keptSet = new Set(kept);

			// Everything else (including newly-appended indices) gets reshuffled
			const remaining = Array.from({ length: queue.length }, (_, i) => i).filter(
				(i) => !keptSet.has(i)
			);
			for (let i = remaining.length - 1; i > 0; i--) {
				const j = Math.floor(Math.random() * (i + 1));
				[remaining[i], remaining[j]] = [remaining[j], remaining[i]];
			}

			shuffleOrder = [...kept, ...remaining];
			persist();
		},

		playNext(item: QueueItem): void {
			if (queue.length === 0) {
				this.playQueue([stampSingleOrigin(item, 'manual')], 0, false);
				showQueueMutationToast('next', 1);
				return;
			}
			const r = insertPlayNext(queue, item, currentIndex, shuffleEnabled, shuffleOrder);
			queue = r.newQueue;
			shuffleOrder = r.newShuffleOrder;
			persist();
			showQueueMutationToast('next', 1);
		},

		playMultipleNext(items: QueueItem[]): void {
			if (items.length === 0) return;
			if (queue.length === 0) {
				this.playQueue(stampOrigin(items, 'manual'), 0, false);
				showQueueMutationToast('next', items.length);
				return;
			}
			const r = insertMultipleNext(queue, items, currentIndex, shuffleEnabled, shuffleOrder);
			queue = r.newQueue;
			shuffleOrder = r.newShuffleOrder;
			persist();
			showQueueMutationToast('next', items.length);
		},

		removeFromQueue(index: number): void {
			if (index < 0 || index >= queue.length) return;
			if (queue.length <= 1) {
				this.stop();
				return;
			}
			const r = removeAtIndex(queue, index, currentIndex, shuffleEnabled, shuffleOrder);
			queue = r.newQueue;
			currentIndex = r.newIndex;
			shuffleOrder = r.newShuffleOrder;
			if (r.wasPlaying) {
				void loadQueueItem(r.newIndex);
			} else {
				persist();
			}
		},

		reorderQueue(fromIndex: number, toIndex: number): void {
			const r = performReorder(queue, fromIndex, toIndex, currentIndex);
			queue = r.newQueue;
			currentIndex = r.newCurrentIndex;
			persist();
		},

		reorderShuffleOrder(fromPos: number, toPos: number): void {
			shuffleOrder = performShuffleReorder(shuffleOrder, fromPos, toPos);
			persist();
		},

		clearQueue(): void {
			radioSession.end();
			if (queue.length === 0 || !queue[currentIndex]) {
				this.stop();
				return;
			}
			const r = clearQueueKeepCurrent(queue, currentIndex);
			queue = r.newQueue;
			currentIndex = r.newIndex;
			shuffleEnabled = false;
			shuffleOrder = [];
			persist();
		},

		changeTrackSource(index: number, newSourceType: SourceType): void {
			if (index < 0 || index >= queue.length) return;
			if (index === currentIndex) {
				playbackToast.show('Cannot change source for the currently playing track', 'warning');
				return;
			}
			const r = changeItemSource(queue, index, newSourceType);
			if (r.error) {
				playbackToast.show(r.error, 'warning');
				return;
			}
			queue = r.newQueue;
			persist();
		},

		/** Radio hydration: patch a not-yet-playing item (video id / preview URL)
		 * without touching the current track. */
		patchQueueItemByPlaylistTrackId(playlistTrackId: string, patch: Partial<QueueItem>): boolean {
			const index = queue.findIndex((q) => q.playlistTrackId === playlistTrackId);
			if (index < 0 || index === currentIndex) return false;
			const uq = [...queue];
			uq[index] = { ...uq[index], ...patch };
			queue = uq;
			persist();
			return true;
		},

		updateQueueItemByPlaylistTrackId(
			playlistTrackId: string,
			newSourceType: SourceType,
			newTrackSourceId: string,
			newFormat?: string,
			plexRatingKey?: string
		): void {
			const r = updateItemByPlaylistTrackId(
				queue,
				playlistTrackId,
				currentIndex,
				newSourceType,
				newTrackSourceId,
				newFormat,
				plexRatingKey
			);
			if (r) {
				queue = r;
				persist();
			}
		},

		play(): void {
			playCurrent();
		},

		pause(): void {
			pauseCurrent();
		},

		togglePlay(): void {
			if (isPlaying) {
				pauseCurrent();
			} else {
				playCurrent();
			}
		},
		seekTo(seconds: number): void {
			seekCurrent(seconds);
		},

		setVolume(level: number): void {
			const clamped = Math.max(0, Math.min(100, level));
			volume = clamped;
			currentSource?.setVolume(clamped);
			storeVolume(clamped);
		},

		async activateKaraoke(instrumentalUrl: string, vocalsUrl: string): Promise<void> {
			const item = queue[currentIndex];
			if (!item || item.sourceType !== 'local') {
				throw new Error('Karaoke is currently available for local tracks only');
			}
			if (karaokeActive) return;
			const startAt = progress;
			const resume = isPlaying;
			const source = new KaraokePlaybackSource(instrumentalUrl, vocalsUrl);
			source.setVocalLevel(karaokeVocalLevel);
			try {
				await replaceCurrentSource(source, startAt, resume);
				karaokeActive = true;
			} catch (error) {
				karaokeActive = false;
				if (queue[currentIndex]?.trackSourceId === item.trackSourceId) {
					await restoreOriginalSource(startAt, resume);
				}
				throw error;
			}
		},

		async deactivateKaraoke(): Promise<void> {
			if (!karaokeActive) return;
			const startAt = progress;
			const resume = isPlaying;
			await restoreOriginalSource(startAt, resume);
			karaokeActive = false;
		},

		setKaraokeVocalLevel(level: number): void {
			karaokeVocalLevel = Math.max(0, Math.min(100, level));
			currentSource?.setVocalLevel?.(karaokeVocalLevel);
		},

		hidePlayer(): void {
			isPlayerVisible = false;
		},

		showPlayer(): void {
			if (nowPlaying) isPlayerVisible = true;
		},

		stop(): void {
			void stopPreviousSession(getCurrentItem(), progress);
			if (errorSkipTimeout) {
				clearTimeout(errorSkipTimeout);
				errorSkipTimeout = null;
			}
			loadGeneration++;
			applyResetState();
		},

		restoreSession(): StoredSession | null {
			return restoreSessionData();
		},

		resumeSession(): void {
			const session = restoreSessionData();
			if (!session) return;
			const resume = buildResumeState(session);
			if (!resume) return;

			queue = resume.queue;
			shuffleEnabled = resume.shuffleEnabled;
			shuffleOrder = resume.shuffleOrder;
			isPlayerVisible = true;
			consecutiveErrors = 0;
			void stopPreviousSession(getCurrentItem(), progress);
			currentSource?.destroy();
			currentIndex = resume.currentIndex;
			playbackState = 'loading';
			isSeekable = true;
			progress = 0;
			duration = 0;
			const gen = ++loadGeneration;

			void (async () => {
				try {
					const { source, loadUrl } = await resolveSourceForItem(resume.currentItem);
					if (gen !== loadGeneration) return;
					currentSource = source;
					nowPlaying = resume.nowPlaying;
					updateMediaSessionMetadata(nowPlaying);
					subscribeToSource(source, gen);
					source.setVolume(volume);
					if (resume.currentItem.sourceType === 'jellyfin') {
						await startJellyfinPlayback(resume.currentIndex);
					}
					await source.load({
						trackSourceId: resume.currentItem.trackSourceId,
						url: loadUrl,
						format: resume.currentItem.format
					});
					if (gen !== loadGeneration) return;
					playbackState = 'paused';
					duration = source.getDuration();
					if (resume.progress > 0) {
						source.seekTo(resume.progress);
						progress = resume.progress;
					}
				} catch {
					if (gen !== loadGeneration) return;
					playbackState = 'error';
					storeSessionData(null);
				}
			})();
		}
	};
}

export const playerStore = createPlayerStore();
