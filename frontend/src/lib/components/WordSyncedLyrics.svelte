<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';

	type AmLyricsElement = HTMLElement & {
		currentTime: number;
		duration: number;
		interpolate: boolean;
		fetchLyrics?: () => void;
	};

	interface Props {
		title: string;
		artist: string;
		album?: string;
		durationSeconds?: number;
		currentTimeSeconds?: number;
		isPlaying?: boolean;
		isrc?: string;
		onseek?: (seconds: number) => void;
	}

	const AM_LYRICS_CDN_URL =
		'https://cdn.jsdelivr.net/npm/@uimaxbai/am-lyrics/dist/src/am-lyrics.min.js';

	let cdnPromise: Promise<void> | null = null;

	function loadAmLyrics(): Promise<void> {
		if (typeof window === 'undefined') return Promise.resolve();
		if (customElements.get('am-lyrics')) return Promise.resolve();
		if (cdnPromise) return cdnPromise;

		cdnPromise = new Promise((resolve, reject) => {
			const existingScript =
				document.querySelector<HTMLScriptElement>(
					'script[data-am-lyrics-cdn]'
				);

			if (existingScript) {
				customElements
					.whenDefined('am-lyrics')
					.then(resolve)
					.catch(reject);

				return;
			}

			const script = document.createElement('script');

			script.type = 'module';
			script.src = AM_LYRICS_CDN_URL;
			script.async = true;
			script.crossOrigin = 'anonymous';
			script.dataset.amLyricsCdn = 'true';

			script.onload = () => {
				customElements
					.whenDefined('am-lyrics')
					.then(resolve)
					.catch(reject);
			};

			script.onerror = () => {
				cdnPromise = null;
				script.remove();

				reject(
					new Error(
						'Failed to load am-lyrics from jsDelivr'
					)
				);
			};

			document.head.appendChild(script);
		});

		return cdnPromise;
	}

	let {
		title,
		artist,
		album = '',
		durationSeconds = 0,
		currentTimeSeconds = 0,
		isPlaying = false,
		isrc = '',
		onseek = () => {}
	}: Props = $props();

	let element = $state<AmLyricsElement | null>(null);
	let clockFrame: number | null = null;
	let anchorMediaTimeMs = 0;
	let anchorWallClockMs = 0;

	let currentSongKey = $derived(
		[title, artist, album, isrc, durationSeconds].join('|')
	);

	function stopClock() {
		if (clockFrame !== null) {
			cancelAnimationFrame(clockFrame);
			clockFrame = null;
		}
	}
	function hideSourceFooter(target: AmLyricsElement) {
		const root = target.shadowRoot;
		if (!root) return;

		if (root.querySelector('style[data-hide-source-footer]')) {
			return;
		}

		const style = document.createElement('style');
		style.dataset.hideSourceFooter = 'true';
		style.textContent = `
			.lyrics-footer .footer-content,
			.download-controls {
				display: none !important;
			}
		`;

		root.appendChild(style);
	}

	function publishCurrentTime(valueMs: number) {
		if (!element) return;
		const durationMs =
			durationSeconds > 0
				? durationSeconds * 1000
				: Infinity;
		const clampedMs = Math.max(
			0,
			Math.min(valueMs, durationMs)
		);

		element.currentTime = clampedMs;
		element.setAttribute(
			'current-time',
			String(clampedMs)
		);
	}

	function runClock() {
		stopClock();
		const frame = () => {
			if (!element || !isPlaying) {
				clockFrame = null;
				return;
			}
			const elapsed =
				performance.now() - anchorWallClockMs;
			publishCurrentTime(
				anchorMediaTimeMs + elapsed
			);
			clockFrame = requestAnimationFrame(frame);
		};
		clockFrame = requestAnimationFrame(frame);
	}

	function anchorClock(
		mediaTimeMs: number,
		startClock = isPlaying
	) {
		anchorMediaTimeMs = Math.max(
			0,
			mediaTimeMs
		);
		anchorWallClockMs = performance.now();
		publishCurrentTime(anchorMediaTimeMs);
		stopClock();
		if (startClock) runClock();
	}

	function applyAttributes(
		target: AmLyricsElement
	) {
		target.setAttribute(
			'song-title',
			title
		);
		target.setAttribute(
			'song-artist',
			artist
		);
		target.setAttribute(
			'query',
			`${title} ${artist}`.trim()
		);

		if (album) {
			target.setAttribute(
				'song-album',
				album
			);
		} else {
			target.removeAttribute(
				'song-album'
			);
		}

		if (durationSeconds > 0) {
			const durationMs = Math.round(
				durationSeconds * 1000
			);
			target.setAttribute(
				'song-duration',
				String(durationMs)
			);
			target.duration = durationMs;
		} else {
			target.removeAttribute(
				'song-duration'
			);
			target.duration = 0;
		}

		if (isrc) {
			target.setAttribute(
				'isrc',
				isrc
			);
		} else {
			target.removeAttribute(
				'isrc'
			);
		}

		target.setAttribute(
			'autoscroll',
			''
		);
		target.setAttribute(
			'interpolate',
			''
		);
		target.interpolate = true;
		target.setAttribute(
			'translation-language',
			'vi'
		);
	}

	onMount(() => {
		const isBrowser =
			typeof window !== 'undefined';
		if (!isBrowser) return;
		let disposed = false;

		const handleLineClick = (
			event: Event
		) => {
			const timestamp = (
				event as CustomEvent<{
					timestamp?: number;
				}>
			).detail?.timestamp;
			if (
				typeof timestamp ===
				'number'
			) {
				onseek(
					timestamp / 1000
				);
			}
		};

		loadAmLyrics().then(async () => {
			if (disposed) return;
			await tick();
			if (disposed || !element)
				return;

			applyAttributes(element);
			element.addEventListener(
				'line-click',
				handleLineClick
			);

			anchorClock(
				Math.max(
					0,
					currentTimeSeconds
				) * 1000,
				isPlaying
			);
			element.fetchLyrics?.();
			hideSourceFooter(element);
		});

		return () => {
			disposed = true;
			stopClock();
			element?.removeEventListener(
				'line-click',
				handleLineClick
			);
		};
	});

	$effect(() => {
		if (!element || !currentSongKey) return;
		applyAttributes(element);
		element.fetchLyrics?.();
	});

	$effect(() => {
		const playing = isPlaying;
		const timeMs =
			Math.max(
				0,
				untrack(
					() => currentTimeSeconds
				)
			) * 1000;

		if (!element) return;

		if (playing) {
			anchorClock(timeMs, true);
		} else {
			stopClock();
			anchorClock(timeMs, false);
		}
	});

	$effect(() => {
		const timeMs =
			Math.max(
				0,
				currentTimeSeconds
			) * 1000;
		const playing = untrack(
			() => isPlaying
		);

		if (!element) return;

		anchorClock(timeMs, playing);
	});
</script>

{#if typeof window !== 'undefined'}
	<div class="word-synced-shell">
		<div
			class="word-synced-host"
			aria-label="Word-synced lyrics"
		>
			<am-lyrics
				bind:this={element}
				class="word-synced-element"
			></am-lyrics>
		</div>
	</div>
{/if}

<style>
	.word-synced-shell,
	.word-synced-host {
		position: relative;
		width: 100%;
		height: 100%;
		min-height: 0;
	}

	.word-synced-host
		:global(.word-synced-element) {
		display: block;
		width: 100%;
		height: 100%;
		color: white;
		font-family: inherit;

		--am-lyrics-inactive-scale: 0.95;
		--am-lyrics-highlight-color: #fff;
		--highlight-color: #fff;
	}
</style>