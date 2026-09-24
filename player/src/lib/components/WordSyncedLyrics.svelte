<script lang="ts">
	// Word-by-word synced lyrics via the <am-lyrics> web component, ported from the
	// main frontend (frontend/src/lib/components/WordSyncedLyrics.svelte). The element
	// fetches lyrics itself (Apple Music-style TTML sources) from its own providers;
	// callers fall back to the server's lyrics when it reports none.
	import { onMount, tick } from 'svelte';

	type AmLyricsElement = HTMLElement & {
		currentTime: number;
		duration: number;
		interpolate: boolean;
		fetchLyrics?: () => void;
	};

	const AM_LYRICS_CDN_URL = 'https://cdn.jsdelivr.net/npm/@uimaxbai/am-lyrics/dist/src/am-lyrics.min.js';
	let amLyricsCdnPromise: Promise<void> | undefined;

	function loadAmLyricsFromCdn(): Promise<void> {
		if (customElements.get('am-lyrics')) return Promise.resolve();
		if (amLyricsCdnPromise) return amLyricsCdnPromise;

		amLyricsCdnPromise = new Promise((resolve, reject) => {
			const existingScript = document.querySelector<HTMLScriptElement>('script[data-am-lyrics-cdn]');
			const script = existingScript ?? document.createElement('script');

			const onLoad = () => {
				customElements.whenDefined('am-lyrics').then(() => resolve(), reject);
			};
			const onError = () => {
				// Allow a retry on the next mount (e.g. after coming back online).
				amLyricsCdnPromise = undefined;
				script.remove();
				reject(new Error('Could not load am-lyrics from jsDelivr'));
			};

			script.addEventListener('load', onLoad, { once: true });
			script.addEventListener('error', onError, { once: true });

			if (!existingScript) {
				script.type = 'module';
				script.src = AM_LYRICS_CDN_URL;
				script.async = true;
				script.crossOrigin = 'anonymous';
				script.dataset.amLyricsCdn = 'true';
				document.head.appendChild(script);
			}
		});

		return amLyricsCdnPromise;
	}

	/** Phones/tablets skip per-frame word interpolation (same policy as the frontend). */
	function usesLowPowerVisuals(): boolean {
		const ua = navigator.userAgent ?? '';
		const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData;
		return (
			uaData?.mobile === true ||
			/iPhone|iPad|iPod|Android|Mobile/i.test(ua) ||
			(/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1) ||
			matchMedia('(hover: none) and (pointer: coarse)').matches
		);
	}

	interface Props {
		title: string;
		artist: string;
		album?: string;
		durationSeconds?: number;
		currentTimeSeconds?: number;
		isPlaying?: boolean;
		isrc?: string;
		onseek?: (seconds: number) => void;
		onavailability?: (available: boolean) => void;
	}

	let {
		title,
		artist,
		album = '',
		durationSeconds = 0,
		currentTimeSeconds = 0,
		isPlaying = false,
		isrc = '',
		onseek = () => {},
		onavailability = () => {}
	}: Props = $props();

	let element = $state<AmLyricsElement | null>(null);
	let loading = $state(true);
	let lyricsObserver: MutationObserver | undefined;
	let initialSyncPending = true;
	let initialSyncFrame: number | undefined;
	const disableWordInterpolation = usesLowPowerVisuals();

	// The audio element only reports time ~4×/s; extrapolate on rAF between
	// samples so word highlighting sweeps smoothly instead of stepping.
	let clockFrame: number | undefined;
	let anchorMediaTimeMs = 0;
	let anchorWallClockMs = 0;

	function publishCurrentTime(valueMs: number): void {
		if (!element) return;
		element.currentTime = valueMs;
	}

	function stopClock(): void {
		if (clockFrame !== undefined) cancelAnimationFrame(clockFrame);
		clockFrame = undefined;
	}

	function runClock(): void {
		clockFrame = requestAnimationFrame(() => {
			clockFrame = undefined;
			if (!element || !isPlaying) return;
			const elapsed = performance.now() - anchorWallClockMs;
			const projected = anchorMediaTimeMs + elapsed;
			const ceiling = durationSeconds > 0 ? durationSeconds * 1000 : Number.POSITIVE_INFINITY;
			publishCurrentTime(Math.min(projected, ceiling));
			runClock();
		});
	}

	function anchorClock(mediaTimeMs: number): void {
		anchorMediaTimeMs = mediaTimeMs;
		anchorWallClockMs = performance.now();
		publishCurrentTime(mediaTimeMs);
		stopClock();
		if (isPlaying) runClock();
	}

	function applyAttributes(target: AmLyricsElement) {
		target.setAttribute('song-title', title);
		target.setAttribute('song-artist', artist);
		target.setAttribute('query', `${title} ${artist}`.trim());
		if (album) target.setAttribute('song-album', album);
		else target.removeAttribute('song-album');
		if (durationSeconds > 0) {
			target.setAttribute('song-duration', String(Math.round(durationSeconds * 1000)));
			target.duration = Math.round(durationSeconds * 1000);
		}
		if (isrc) target.setAttribute('isrc', isrc);
		else target.removeAttribute('isrc');
		if (initialSyncPending) target.removeAttribute('autoscroll');
		else target.setAttribute('autoscroll', '');
		if (disableWordInterpolation) {
			target.removeAttribute('interpolate');
			target.interpolate = false;
		} else {
			target.setAttribute('interpolate', '');
			target.interpolate = true;
		}
	}

	/** Jump (not smooth-scroll) to the current line once lyrics first render. */
	function scheduleInitialSync(target: AmLyricsElement): void {
		if (!initialSyncPending || initialSyncFrame !== undefined) return;

		initialSyncFrame = requestAnimationFrame(() => {
			initialSyncFrame = undefined;
			if (!initialSyncPending) return;

			const root = target.shadowRoot;
			const container = root?.querySelector<HTMLElement>('.lyrics-container');
			const activeLine = root?.querySelector<HTMLElement>('.lyrics-line.active, .lyrics-line.pre-active');
			if (!container || !activeLine) return;

			const scrollPaddingTop = container.clientHeight * 0.12;
			const targetScrollTop = Math.max(0, activeLine.offsetTop - scrollPaddingTop);
			const previousScrollBehavior = container.style.scrollBehavior;
			container.style.scrollBehavior = 'auto';
			container.scrollTop = targetScrollTop;
			container.style.scrollBehavior = previousScrollBehavior;

			initialSyncPending = false;
			target.setAttribute('autoscroll', '');
		});
	}

	let reported = false;
	let giveUpTimer: ReturnType<typeof setTimeout> | undefined;

	function report(available: boolean) {
		clearTimeout(giveUpTimer);
		loading = false;
		if (reported && available) return;
		reported = true;
		onavailability(available);
	}

	function reportAvailability(target: AmLyricsElement): void {
		const root = target.shadowRoot;
		if (!root) return;
		if (root.querySelector('.lyrics-line')) report(true);
		else if (root.querySelector('.no-lyrics')) report(false);
	}

	function hideSourceFooter(target: AmLyricsElement): void {
		const root = target.shadowRoot;
		if (!root || root.querySelector('style[data-hide-source-footer]')) return;

		const style = document.createElement('style');
		style.dataset.hideSourceFooter = 'true';
		style.textContent = '.lyrics-footer .footer-content, .download-controls { display: none !important; }';
		root.appendChild(style);
	}

	onMount(() => {
		let disposed = false;
		const handleLineClick = (event: Event) => {
			const timestamp = (event as CustomEvent<{ timestamp?: number }>).detail?.timestamp;
			if (typeof timestamp === 'number') onseek(timestamp / 1000);
		};

		void loadAmLyricsFromCdn()
			.then(async () => {
				if (disposed) return;
				await customElements.whenDefined('am-lyrics');
				if (disposed) return;
				if (!element) await tick();
				const target = element;
				if (!target) {
					report(false);
					return;
				}
				applyAttributes(target);
				target.fetchLyrics?.();
				// Providers occasionally hang without rendering either state.
				giveUpTimer = setTimeout(() => !reported && report(false), 12_000);
				anchorClock(Math.max(0, currentTimeSeconds * 1000));
				target.addEventListener('line-click', handleLineClick);
				const root = target.shadowRoot;
				if (root) {
					hideSourceFooter(target);
					lyricsObserver = new MutationObserver(() => {
						hideSourceFooter(target);
						reportAvailability(target);
						scheduleInitialSync(target);
					});
					lyricsObserver.observe(root, { childList: true, subtree: true });
				}
				reportAvailability(target);
				scheduleInitialSync(target);
			})
			.catch((error) => {
				// CDN blocked/offline: let the caller show the server's lyrics instead.
				console.warn('Failed to load word-synced lyrics', error);
				if (!disposed) report(false);
			});

		return () => {
			disposed = true;
			clearTimeout(giveUpTimer);
			lyricsObserver?.disconnect();
			lyricsObserver = undefined;
			if (initialSyncFrame !== undefined) cancelAnimationFrame(initialSyncFrame);
			initialSyncFrame = undefined;
			stopClock();
			element?.removeEventListener('line-click', handleLineClick);
		};
	});

	$effect(() => {
		if (!element) return;
		applyAttributes(element);
	});

	$effect(() => {
		// Read both dependencies before the guard so the effect re-runs when
		// playback starts or stops, not only when a new sample arrives: pausing
		// must halt the extrapolation, and resuming must restart it.
		const nextTimeMs = Math.max(0, currentTimeSeconds) * 1000;
		const playing = isPlaying;
		if (!element) return;
		if (!playing) stopClock();
		anchorClock(nextTimeMs);
	});
</script>

<div class="word-synced-shell">
	<div class="word-synced-host" aria-label="Word-synced lyrics">
		<am-lyrics bind:this={element} translation-language="vi" class="word-synced-element"></am-lyrics>
	</div>
	{#if loading}
		<div class="word-synced-status">
			<span class="spin" aria-hidden="true"></span>
			<span>Finding word-synced lyrics…</span>
		</div>
	{/if}
</div>

<style>
	.word-synced-shell,
	.word-synced-host {
		position: relative;
		height: 100%;
		min-height: 0;
		width: 100%;
	}

	.word-synced-host :global(.word-synced-element) {
		display: block;
		height: 100%;
		width: 100%;
		color: white;
		font-family: inherit;
		--am-lyrics-inactive-scale: 0.95;
		--am-lyrics-highlight-color: #fff;
		--highlight-color: #fff;
	}

	.word-synced-status {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.75rem;
		color: rgb(255 255 255 / 0.68);
		font-size: 0.875rem;
	}

	.spin {
		width: 20px;
		height: 20px;
		border-radius: 50%;
		border: 2.5px solid rgb(255 255 255 / 0.25);
		border-top-color: rgb(255 255 255 / 0.8);
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
