<script lang="ts">
	import { onMount } from 'svelte';
	import { AlertCircle, Loader2 } from 'lucide-svelte';
	import { usesMobileLowPowerVisuals } from '$lib/utils/mobilePerformance';

	type AmLyricsElement = HTMLElement & {
		currentTime: number;
		duration: number;
		interpolate: boolean;
	};

	const AM_LYRICS_CDN_URL =
		'https://cdn.jsdelivr.net/npm/@uimaxbai/am-lyrics@1.6.1/dist/src/am-lyrics.min.js';
	let amLyricsCdnPromise: Promise<void> | undefined;

	function loadAmLyricsFromCdn(): Promise<void> {
		if (customElements.get('am-lyrics')) return Promise.resolve();
		if (amLyricsCdnPromise) return amLyricsCdnPromise;

		amLyricsCdnPromise = new Promise((resolve, reject) => {
			const existingScript = document.querySelector<HTMLScriptElement>(
				'script[data-am-lyrics-cdn]'
			);
			const script = existingScript ?? document.createElement('script');

			const onLoad = () => {
				customElements.whenDefined('am-lyrics').then(() => resolve(), reject);
			};
			const onError = () => reject(new Error('Could not load am-lyrics from jsDelivr'));

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

	interface Props {
		title: string;
		artist: string;
		album?: string;
		durationSeconds?: number;
		currentTimeSeconds?: number;
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
		isrc = '',
		onseek = () => {},
		onavailability = () => {}
	}: Props = $props();

	let element = $state<AmLyricsElement | null>(null);
	let loading = $state(true);
	let failed = $state(false);
	let lyricsObserver: MutationObserver | undefined;
	const disableWordInterpolation = usesMobileLowPowerVisuals();

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
		target.setAttribute('highlight-color', '#ffffff');
		target.setAttribute('hover-background-color', 'rgba(255, 255, 255, 0.08)');
		target.setAttribute('autoscroll', '');
		// am-lyrics defaults interpolate=true and keeps a requestAnimationFrame
		// loop alive for smooth syllable highlighting. That loop is the dominant
		// CPU cost observed on mobile while lyrics are open, so use discrete word
		// updates there while retaining synchronized lyrics and auto-scroll.
		if (disableWordInterpolation) {
			target.removeAttribute('interpolate');
			target.interpolate = false;
		} else {
			target.setAttribute('interpolate', '');
			target.interpolate = true;
		}
	}

	function injectMonochromeStyle(target: AmLyricsElement, attempts = 0) {
		const root = target.shadowRoot;
		if (!root) {
			if (attempts < 30) requestAnimationFrame(() => injectMonochromeStyle(target, attempts + 1));
			return;
		}
		if (root.getElementById('droppedneedle-word-lyrics-theme')) return;
		const style = document.createElement('style');
		style.id = 'droppedneedle-word-lyrics-theme';
		style.textContent = `
			.lyrics-container {
				scrollbar-width: none !important;
				padding: clamp(18vh, 22vh, 26vh) clamp(1.25rem, 5vw, 4rem) !important;
			}
			@media (min-width: 768px) {
				.lyrics-container {
					padding-top: 5vh !important;
					padding-bottom: 5vh !important;
				}
			}
			.lyrics-container::-webkit-scrollbar { display: none !important; }
			.lyrics-line {
				transform-origin: left center;
				font-weight: 700 !important;
				transition: opacity .42s ease, transform .55s cubic-bezier(.22,1,.36,1), filter .48s ease !important;
			}
			.lyrics-line:not(.active):not(.pre-active) { opacity: .30; filter: blur(.15px); }
			.lyrics-line.active { opacity: 1; font-weight: 700 !important; }
			.lyrics-line.pre-active { opacity: .58; }
			.lyrics-line-container { transition: transform .7s cubic-bezier(.22,1,.36,1) !important; }
			.lyrics-line.active .lyrics-line-container,
			.lyrics-line.pre-active .lyrics-line-container {
				transition: transform .7s cubic-bezier(.22,1,.36,1) !important;
			}
			.no-lyrics { color: rgba(255,255,255,.55) !important; font-size: 1rem !important; }
			${
				disableWordInterpolation
					? `
					.lyrics-line { filter: none !important; }
					.lyrics-line::before,
					.lyrics-line-container,
					.lyrics-word,
					.lyrics-syllable,
					.lyrics-syllable span.char {
						animation: none !important;
						transition: none !important;
						transform: none !important;
					}
					/* Replace the animated wipe with an immediate state change. The
					   component still applies .highlight at the word start, but mobile
					   avoids per-character animation work. */
					.lyrics-syllable.highlight,
					.lyrics-syllable.finished {
						background-image: none !important;
						background-color: var(--lyplus-text-primary) !important;
						color: var(--lyplus-text-primary) !important;
					}
					.lyrics-syllable.highlight span.char,
					.lyrics-syllable.finished span.char {
						background-image: none !important;
						background-color: var(--lyplus-text-primary) !important;
						color: var(--lyplus-text-primary) !important;
						-webkit-text-fill-color: var(--lyplus-text-primary) !important;
					}
					/* Keep am-lyrics' scroll-animate transform so line scrolling remains smooth. */
					.lyrics-line.active:not(.scroll-animate) { transform: none !important; }
					.lyrics-line-container { transform: none !important; }
					`
					: ''
			}
		`;
		root.appendChild(style);
	}

	function reportAvailability(target: AmLyricsElement): void {
		const root = target.shadowRoot;
		if (!root) return;
		if (root.querySelector('.lyrics-line')) {
			onavailability(true);
		} else if (root.querySelector('.no-lyrics')) {
			onavailability(false);
		}
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
				const target = element;
				if (!target) return;
				applyAttributes(target);
				(target as AmLyricsElement & { fetchLyrics?: () => void }).fetchLyrics?.();
				target.currentTime = Math.max(0, currentTimeSeconds * 1000);
				target.addEventListener('line-click', handleLineClick);
				const root = target.shadowRoot;
				if (root) {
					lyricsObserver = new MutationObserver(() => reportAvailability(target));
					lyricsObserver.observe(root, { childList: true, subtree: true });
				}
				reportAvailability(target);
				loading = false;
				injectMonochromeStyle(target);
			})
			.catch((error) => {
				console.warn('Failed to load word-synced lyrics', error);
				if (!disposed) {
					loading = false;
					failed = true;
					onavailability(false);
				}
			});

		return () => {
			disposed = true;
			lyricsObserver?.disconnect();
			lyricsObserver = undefined;
			element?.removeEventListener('line-click', handleLineClick);
		};
	});

	$effect(() => {
		if (!element) return;
		applyAttributes(element);
	});

	$effect(() => {
		if (!element) return;
		element.currentTime = Math.max(0, currentTimeSeconds * 1000);
	});
</script>

<div class="word-synced-shell">
	<div class="word-synced-host" aria-label="Word-synced lyrics">
		<am-lyrics
			bind:this={element}
			translation-language="vi"
			class="word-synced-element"
			hide-source-footer="true"
		></am-lyrics>
	</div>
	{#if loading}
		<div class="word-synced-status">
			<Loader2 class="h-6 w-6 animate-spin" />
			<span>Finding word-synced lyrics…</span>
		</div>
	{:else if failed}
		<div class="word-synced-status text-warning">
			<AlertCircle class="h-6 w-6" />
			<span>Word-synced lyrics could not be loaded.</span>
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
		color: rgba(255, 255, 255, 0.68);
		font-size: 0.875rem;
	}
</style>
