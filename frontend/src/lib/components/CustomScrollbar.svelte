<script lang="ts">
	import { onMount } from 'svelte';

	let scrollbar: HTMLDivElement;
	let thumb: HTMLDivElement;

	onMount(() => {
		let frame = 0;
		let dragOffset = 0;
		let dragging = false;
		let scrollTarget: Window | HTMLElement = window;
		let hideTimer: ReturnType<typeof setTimeout> | undefined;
		const resizeObserver = new ResizeObserver(() => update());

		const resolveScrollTarget = (): Window | HTMLElement => {
			const candidates = [
				document.querySelector<HTMLElement>('.drawer-content'),
				document.scrollingElement
			].filter((candidate): candidate is HTMLElement => Boolean(candidate));
			return (
				candidates.find((candidate) => candidate.scrollHeight > candidate.clientHeight + 1) ?? window
			);
		};

		const update = (show = false) => {
			if (frame) cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				scrollTarget = resolveScrollTarget();
				const viewportHeight =
					scrollTarget === window ? window.innerHeight : scrollTarget.clientHeight;
				const contentHeight =
					scrollTarget === window ? document.documentElement.scrollHeight : scrollTarget.scrollHeight;
				const maxScroll = Math.max(contentHeight - viewportHeight, 0);
				const trackInset = 8;
				const trackHeight = Math.max(viewportHeight - trackInset * 2, 0);
				const thumbHeight = Math.max((viewportHeight / contentHeight) * trackHeight, 32);
				const thumbTravel = Math.max(trackHeight - thumbHeight, 0);
				const scrollTop = scrollTarget === window ? window.scrollY : scrollTarget.scrollTop;
				const thumbTop = trackInset + (maxScroll ? (scrollTop / maxScroll) * thumbTravel : 0);

				thumb.style.height = `${thumbHeight}px`;
				thumb.style.transform = `translateY(${thumbTop}px)`;
				scrollbar.hidden = maxScroll === 0;
				if (show && maxScroll > 0) {
					scrollbar.dataset.active = 'true';
					if (hideTimer) clearTimeout(hideTimer);
					if (!dragging) {
						hideTimer = setTimeout(() => {
							delete scrollbar.dataset.active;
						}, 700);
					}
				}
			});
		};

		const handleScroll = (event: Event) => {
			if (event.target instanceof HTMLElement && event.target.scrollHeight > event.target.clientHeight + 1) {
				scrollTarget = event.target;
			}
			update(true);
		};
		const handleResize = () => update();
		const handlePointerMove = (event: PointerEvent) => {
			if (!dragging) return;
				const trackInset = 8;
				const viewportHeight = scrollTarget === window ? window.innerHeight : scrollTarget.clientHeight;
				const trackHeight = viewportHeight - trackInset * 2;
				const thumbHeight = thumb.offsetHeight;
				const thumbTravel = Math.max(trackHeight - thumbHeight, 0);
				const contentHeight =
					scrollTarget === window ? document.documentElement.scrollHeight : scrollTarget.scrollHeight;
				const maxScroll = Math.max(contentHeight - viewportHeight, 0);
				const nextTop = Math.min(Math.max(event.clientY - dragOffset - trackInset, 0), thumbTravel);
				const nextScrollTop = thumbTravel ? (nextTop / thumbTravel) * maxScroll : 0;
				if (scrollTarget === window) window.scrollTo({ top: nextScrollTop, behavior: 'auto' });
				else scrollTarget.scrollTop = nextScrollTop;
			update();
		};
		const handlePointerUp = () => {
			dragging = false;
			delete scrollbar.dataset.dragging;
			update(true);
		};
		const handleTrackPointerDown = (event: PointerEvent) => {
			if (event.target === thumb || thumb.contains(event.target as Node)) return;
			const target = event.clientY < thumb.getBoundingClientRect().top ? -1 : 1;
			const viewportHeight = scrollTarget === window ? window.innerHeight : scrollTarget.clientHeight;
			if (scrollTarget === window) window.scrollBy({ top: target * viewportHeight * 0.85, behavior: 'smooth' });
			else scrollTarget.scrollBy({ top: target * viewportHeight * 0.85, behavior: 'smooth' });
			update(true);
		};
		const handleThumbPointerDown = (event: PointerEvent) => {
			event.preventDefault();
			dragging = true;
			dragOffset = event.clientY - thumb.getBoundingClientRect().top;
			scrollbar.dataset.dragging = 'true';
			thumb.setPointerCapture(event.pointerId);
		};

		window.addEventListener('scroll', handleScroll, { passive: true, capture: true });
		window.addEventListener('resize', handleResize, { passive: true });
		window.addEventListener('pointermove', handlePointerMove);
		window.addEventListener('pointerup', handlePointerUp);
		scrollbar.addEventListener('pointerdown', handleTrackPointerDown);
		thumb.addEventListener('pointerdown', handleThumbPointerDown);
		resizeObserver.observe(document.documentElement);
		resizeObserver.observe(document.body);
		update();
		void document.fonts?.ready.then(() => update());

		return () => {
			if (frame) cancelAnimationFrame(frame);
			if (hideTimer) clearTimeout(hideTimer);
			window.removeEventListener('scroll', handleScroll, true);
			window.removeEventListener('resize', handleResize);
			window.removeEventListener('pointermove', handlePointerMove);
			window.removeEventListener('pointerup', handlePointerUp);
			scrollbar.removeEventListener('pointerdown', handleTrackPointerDown);
			thumb.removeEventListener('pointerdown', handleThumbPointerDown);
			resizeObserver.disconnect();
		};
	});
</script>

<div bind:this={scrollbar} class="custom-scrollbar" aria-hidden="true">
	<div bind:this={thumb} class="custom-scrollbar-thumb"></div>
</div>

<style>
	.custom-scrollbar {
		position: fixed;
		inset: 0 1px 0 auto;
		z-index: 100;
		width: 10px;
		padding: 8px 2px;
		touch-action: none;
		opacity: 0;
		transition: opacity 180ms ease;
	}

	.custom-scrollbar[data-active='true'],
	.custom-scrollbar[data-dragging='true'] {
		opacity: 1;
	}

	.custom-scrollbar:not([hidden]) {
		opacity: 0.72;
	}

	.custom-scrollbar-thumb {
		width: 6px;
		min-height: 32px;
		border-radius: 999px;
		background: color-mix(in oklab, var(--color-base-content) 48%, transparent);
		cursor: grab;
	}

	.custom-scrollbar[data-dragging='true'] .custom-scrollbar-thumb {
		background: color-mix(in oklab, var(--color-base-content) 68%, transparent);
		cursor: grabbing;
	}

	:global(html.lyrics-page-scroll-lock .custom-scrollbar) {
		display: none;
	}

	@media (prefers-reduced-motion: reduce) {
		.custom-scrollbar {
			transition: none;
		}
	}
</style>
