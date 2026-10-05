<script lang="ts">
	import { onMount, untrack } from "svelte";

	type AmLyricsElement = HTMLElement & {
		currentTime: number;
		duration: number;
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
		maxFps?: number;
		onseek?: (seconds: number) => void;
	}

	const AM_LYRICS_CDN_URL =
		"https://cdn.jsdelivr.net/npm/@uimaxbai/am-lyrics@1.7.2/dist/src/am-lyrics.min.js";


	let cdnPromise: Promise<void> | null = null;

	function loadAmLyrics(): Promise<void> {
		if (typeof window === "undefined") return Promise.resolve();
		if (customElements.get("am-lyrics")) return Promise.resolve();
		if (cdnPromise) return cdnPromise;

		cdnPromise = new Promise<void>((resolve, reject) => {
			const whenDefined = () =>
				customElements
					.whenDefined("am-lyrics")
					.then(() => resolve(), reject);

			if (document.querySelector("script[data-am-lyrics-cdn]")) {
				whenDefined();
				return;
			}

			const script = document.createElement("script");
			script.type = "module";
			script.src = AM_LYRICS_CDN_URL;
			script.crossOrigin = "anonymous";
			script.dataset.amLyricsCdn = "true";

			script.onload = whenDefined;
			script.onerror = () => {
				cdnPromise = null;
				script.remove();
				reject(new Error("Failed to load am-lyrics from jsDelivr"));
			};

			document.head.appendChild(script);
		});

		return cdnPromise;
	}

	// ---------------------------------------------------------------------------
	// Props & state
	// ---------------------------------------------------------------------------

	let {
		title,
		artist,
		album = "",
		durationSeconds = 0,
		currentTimeSeconds = 0,
		isPlaying = false,
		isrc = "",
		maxFps = 60,
		onseek = () => {},
	}: Props = $props();

	/**
	 * Nếu thời gian player báo về lệch ít hơn ngưỡng này so với clock nội bộ
	 * thì chỉ chỉnh mốc, không publish ngay → không phá giới hạn maxFps.
	 * Lệch lớn hơn (seek, tua) mới cập nhật tức thì.
	 */
	const RESYNC_THRESHOLD_MS = 300;

	let element = $state<AmLyricsElement | null>(null);
	let ready = $state(false);
	let isPhone = $state(false);

	const durationMs = $derived(
		durationSeconds > 0 ? Math.round(durationSeconds * 1000) : 0,
	);
	const songKey = $derived(
		[title, artist, album, isrc, durationSeconds].join("|"),
	);

	// Clock: không cần reactive, chỉ dùng nội bộ
	let clockFrame: ReturnType<typeof setInterval> | null = null;
	let anchorMediaTimeMs = 0;
	let anchorWallClockMs = 0;

	let disposed = false;

	// ---------------------------------------------------------------------------
	// Clock
	// ---------------------------------------------------------------------------

	function clampTime(ms: number): number {
		const max = durationMs > 0 ? durationMs : Infinity;
		return Math.min(Math.max(0, ms), max);
	}

	/**
	 * Gán thời gian hiện tại cho element.
	 * am-lyrics xử lý currentTime qua setter (không qua render của Lit),
	 * nên chỉ cần gán property; attribute 'current-time' không được lắng nghe.
	 */
	function publishCurrentTime(ms: number) {
		if (!element) return;
		const t = clampTime(ms);
		element.currentTime = t;
	}

	function stopClock() {
		if (clockFrame !== null) {
			clearInterval(clockFrame);
			clockFrame = null;
		}
	}

	/**
	 * Chạy bằng setInterval với nhịp `maxFps` thay vì rAF: rAF thức dậy ở mọi
	 * vsync (60–120Hz) dù chỉ publish 15 lần/giây, tốn pin trên điện thoại.
	 */
	function runClock() {
		stopClock();

		const tick = () => {
			if (!element || !isPlaying) return stopClock();
			// performance.now() có thể nhỉnh hơn mốc một chút → chặn để không chạy lùi.
			const elapsed = Math.max(0, performance.now() - anchorWallClockMs);
			publishCurrentTime(anchorMediaTimeMs + elapsed);
		};

		tick(); // frame đầu luôn được chạy
		if (!element || !isPlaying) return;
		clockFrame = setInterval(tick, 1000 / (maxFps > 0 ? maxFps : 60));
	}

	function anchorClock(mediaTimeMs: number, playing: boolean) {
		const now = performance.now();
		const target = clampTime(mediaTimeMs);

		if (document.hidden) {
			anchorMediaTimeMs = target;
			anchorWallClockMs = now;
			stopClock();
			return;
		}

		if (playing && clockFrame !== null) {
			const predicted = anchorMediaTimeMs + (now - anchorWallClockMs);
			if (Math.abs(target - predicted) < RESYNC_THRESHOLD_MS) {
				anchorMediaTimeMs = target;
				anchorWallClockMs = now;
				return;
			}
		}

		anchorMediaTimeMs = target;
		anchorWallClockMs = now;
		publishCurrentTime(target);

		if (playing) runClock();
		else stopClock();
	}

	// ---------------------------------------------------------------------------
	// Element setup
	// ---------------------------------------------------------------------------

	function setOrRemove(target: HTMLElement, name: string, value: string) {
		if (value) target.setAttribute(name, value);
		else target.removeAttribute(name);
	}

	function applyAttributes(target: AmLyricsElement) {
		target.setAttribute("song-title", title);
		target.setAttribute("song-artist", artist);
		target.setAttribute("query", `${title} ${artist}`.trim());
		setOrRemove(target, "song-album", album);
		setOrRemove(target, "isrc", isrc);
		setOrRemove(
			target,
			"song-duration",
			durationMs ? String(durationMs) : "",
		);
		target.duration = durationMs;

		target.setAttribute("autoscroll", "");
		target.setAttribute("translation-language", "vi");
	}

	function hideSourceFooter(target: AmLyricsElement) {
		const root = target.shadowRoot;
		if (!root || root.querySelector("style[data-hide-source-footer]"))
			return;

		const style = document.createElement("style");
		style.dataset.hideSourceFooter = "true";
		style.textContent = `
			.lyrics-footer .footer-content,
			.download-controls {
				display: none !important;
			}
		`;
		root.appendChild(style);
	}

	// ---------------------------------------------------------------------------
	// Lifecycle
	// ---------------------------------------------------------------------------

	onMount(() => {
		loadAmLyrics()
			.then(() => {
				if (!disposed) ready = true;
			})
			.catch((error) => console.error(error));

		// Hiện lại → publish ngay thời gian hiện tại và chạy lại clock nếu đang phát.
		const onVisibilityChange = () => {
			if (document.hidden) stopClock();
			else if (ready && element)
				anchorClock(Math.max(0, currentTimeSeconds) * 1000, isPlaying);
		};
		document.addEventListener("visibilitychange", onVisibilityChange);

		return () => {
			disposed = true;
			document.removeEventListener("visibilitychange", onVisibilityChange);
			stopClock();
		};
	});

	$effect(() => {
		// Phones and tablets (iPad): per-line filter: blur is re-rasterised on every
		// publish, too costly on mobile GPUs.
		const mq = window.matchMedia("(max-width: 899px), (pointer: coarse)");
		const update = () => (isPhone = mq.matches);
		update();
		mq.addEventListener("change", update);
		return () => mq.removeEventListener("change", update);
	});

	$effect(() => {
		const target = element;
		if (!target) return;
		target.toggleAttribute("no-blur", isPhone);
	});

	// Gắn listener + ẩn footer, một lần khi element sẵn sàng
	$effect(() => {
		const target = element;
		if (!ready || !target) return;

		const handleLineClick = (event: Event) => {
			const timestamp = (event as CustomEvent<{ timestamp?: number }>)
				.detail?.timestamp;
			if (typeof timestamp === "number") onseek(timestamp / 1000);
		};

		target.addEventListener("line-click", handleLineClick);
		hideSourceFooter(target);

		return () => target.removeEventListener("line-click", handleLineClick);
	});

	// Đổi bài → cập nhật attribute và fetch lời (chỉ một lần mỗi bài)
	$effect(() => {
		const target = element;
		songKey; // dependency
		if (!ready || !target) return;

		untrack(() => {
			applyAttributes(target);
			target.fetchLyrics?.();
		});
	});

	// Play/pause hoặc seek/timeupdate từ player → re-anchor clock
	$effect(() => {
		const target = element;
		const playing = isPlaying;
		const timeMs = Math.max(0, currentTimeSeconds) * 1000;
		if (!ready || !target) return;

		untrack(() => anchorClock(timeMs, playing));
	});
</script>

{#if typeof window !== "undefined"}
	<div class="word-synced-shell">
		<div class="word-synced-host" aria-label="Word-synced lyrics">
			<am-lyrics bind:this={element} class="word-synced-element"
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

	.word-synced-host :global(.word-synced-element) {
		display: block;
		width: 100%;
		height: 100%;
		margin-top: 8px;
		color: white;
		font-family: inherit;

		--am-lyrics-inactive-scale: 0.95;
		--am-lyrics-highlight-color: #fff;
		--highlight-color: #fff;
	}
</style>
