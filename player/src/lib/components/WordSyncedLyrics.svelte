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
		/** Giới hạn FPS của clock. 0 = không giới hạn (theo refresh rate màn hình). */
		maxFps?: number;
		onseek?: (seconds: number) => void;
	}

	const AM_LYRICS_CDN_URL =
		"https://cdn.jsdelivr.net/npm/@uimaxbai/am-lyrics@1.7.2/dist/src/am-lyrics.min.js";

	// ---------------------------------------------------------------------------
	// CDN loader (dùng chung cho mọi instance)
	// ---------------------------------------------------------------------------

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

	/** Dung sai cho jitter của rAF, tránh bỏ frame oan trên màn 60Hz. */
	const FRAME_TOLERANCE_MS = 2;
	/**
	 * Nếu thời gian player báo về lệch ít hơn ngưỡng này so với clock nội bộ
	 * thì chỉ chỉnh mốc, không publish ngay → không phá giới hạn maxFps.
	 * Lệch lớn hơn (seek, tua) mới cập nhật tức thì.
	 */
	const RESYNC_THRESHOLD_MS = 300;

	let element = $state<AmLyricsElement | null>(null);
	/** true khi custom element đã được define và upgrade xong */
	let ready = $state(false);

	const durationMs = $derived(
		durationSeconds > 0 ? Math.round(durationSeconds * 1000) : 0,
	);
	const songKey = $derived(
		[title, artist, album, isrc, durationSeconds].join("|"),
	);

	// Clock: không cần reactive, chỉ dùng nội bộ
	let clockFrame: number | null = null;
	let anchorMediaTimeMs = 0;
	let anchorWallClockMs = 0;

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
			cancelAnimationFrame(clockFrame);
			clockFrame = null;
		}
	}

	/**
	 * Chạy theo rAF, giới hạn tối đa `maxFps`.
	 * - Có dung sai để jitter không làm rớt frame trên màn 60Hz.
	 * - Giữ nhịp cố định (trừ phần dư) để trung bình đúng target FPS,
	 *   kể cả trên màn 144Hz không chia hết cho 60.
	 */
	function runClock() {
		stopClock();

		let lastFrameTime = -Infinity; // frame đầu luôn được chạy

		const frame = (now: DOMHighResTimeStamp) => {
			if (!element || !isPlaying) {
				clockFrame = null;
				return;
			}

			clockFrame = requestAnimationFrame(frame);

			// Đọc mỗi frame để đổi maxFps lúc đang phát cũng có hiệu lực ngay
			const frameInterval = maxFps > 0 ? 1000 / maxFps : 0;

			if (frameInterval > 0) {
				const delta = now - lastFrameTime;
				if (delta < frameInterval - FRAME_TOLERANCE_MS) return;

				// Lệch quá xa (frame đầu, tab vừa active lại) → reset nhịp
				lastFrameTime =
					delta > frameInterval * 2
						? now
						: now - (delta % frameInterval);
			}

			// Timestamp của rAF có thể nhỏ hơn anchorWallClockMs một chút
			// (thời điểm bắt đầu frame) → chặn để thời gian không chạy lùi.
			const elapsed = Math.max(0, now - anchorWallClockMs);
			publishCurrentTime(anchorMediaTimeMs + elapsed);
		};

		clockFrame = requestAnimationFrame(frame);
	}

	function anchorClock(mediaTimeMs: number, playing: boolean) {
		const now = performance.now();
		const target = clampTime(mediaTimeMs);

		// Đang phát và player chỉ báo timeupdate bình thường (không seek):
		// dời mốc cho khớp player, để clock tự publish theo nhịp maxFps.
		if (playing && clockFrame !== null) {
			const predicted = anchorMediaTimeMs + (now - anchorWallClockMs);
			if (Math.abs(target - predicted) < RESYNC_THRESHOLD_MS) {
				anchorMediaTimeMs = target;
				anchorWallClockMs = now;
				return;
			}
		}

		// Play/pause, seek, đổi bài → cập nhật ngay
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
		let disposed = false;

		loadAmLyrics()
			.then(() => {
				if (!disposed) ready = true;
			})
			.catch((error) => console.error(error));

		return () => {
			disposed = true;
			stopClock();
		};
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
		color: white;
		font-family: inherit;

		--am-lyrics-inactive-scale: 0.95;
		--am-lyrics-highlight-color: #fff;
		--highlight-color: #fff;
	}
</style>
