<script lang="ts">
	import { onMount } from 'svelte';
	import { AlertCircle, Loader2 } from 'lucide-svelte';

	type AmLyricsElement = HTMLElement & {
		currentTime: number;
		duration: number;
	};

	interface Props {
		title: string;
		artist: string;
		album?: string;
		durationSeconds?: number;
		currentTimeSeconds?: number;
		isrc?: string;
		onseek?: (seconds: number) => void;
	}

	let {
		title,
		artist,
		album = '',
		durationSeconds = 0,
		currentTimeSeconds = 0,
		isrc = '',
		onseek = () => {},
	}: Props = $props();

	let element = $state<AmLyricsElement | null>(null);
	let loading = $state(true);
	let failed = $state(false);

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
		target.setAttribute('interpolate', '');
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
			.lyrics-container::-webkit-scrollbar { display: none !important; }
			.lyrics-line {
				transform-origin: left center;
				transition: opacity .42s ease, transform .55s cubic-bezier(.22,1,.36,1), filter .48s ease !important;
			}
			.lyrics-line:not(.active):not(.pre-active) { opacity: .30; filter: blur(.15px); }
			.lyrics-line.active { transform: scale(1.018); opacity: 1; }
			.lyrics-line.pre-active { opacity: .58; }
			.lyrics-line-container { transition: transform .55s cubic-bezier(.22,1,.36,1) !important; }
			.no-lyrics { color: rgba(255,255,255,.55) !important; font-size: 1rem !important; }
		`;
		root.appendChild(style);
	}

	onMount(() => {
		let disposed = false;
		const handleLineClick = (event: Event) => {
			const timestamp = (event as CustomEvent<{ timestamp?: number }>).detail?.timestamp;
			if (typeof timestamp === 'number') onseek(timestamp / 1000);
		};

		void import('@uimaxbai/am-lyrics/am-lyrics.js')
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
				loading = false;
				injectMonochromeStyle(target);
			})
			.catch((error) => {
				console.warn('Failed to load word-synced lyrics', error);
				if (!disposed) {
					loading = false;
					failed = true;
				}
			});

		return () => {
			disposed = true;
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
		<am-lyrics bind:this={element} class="word-synced-element"></am-lyrics>
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
