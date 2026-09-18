<script lang="ts">
	import { CirclePlay, Play, ListEnd } from 'lucide-svelte';
	import { playerStore } from '$lib/stores/player.svelte';

	interface Props {
		/** Triggered when user confirms play now */
		onPlayNow: () => void;
		/** Triggered when user confirms play next */
		onPlayNext: () => void;
		/** Triggered when user confirms add to queue */
		onAddToQueue: () => void;
		/** Position of anchor element to position the menu against */
		anchorRect: DOMRect;
		onClose: () => void;
	}

	let { onPlayNow, onPlayNext, onAddToQueue, anchorRect, onClose }: Props = $props();

	const MENU_WIDTH = 192;
	const VIEWPORT_MARGIN = 8;

	let menuEl = $state<HTMLDivElement | null>(null);

	const menuTop = $derived.by(() => {
		const estimatedHeight = 140;
		let top = anchorRect.bottom + 6;
		if (top + estimatedHeight > window.innerHeight - VIEWPORT_MARGIN) {
			top = anchorRect.top - estimatedHeight - 6;
		}
		return Math.max(VIEWPORT_MARGIN, top);
	});

	const menuLeft = $derived.by(() => {
		let left = anchorRect.left;
		if (left + MENU_WIDTH > window.innerWidth - VIEWPORT_MARGIN) {
			left = anchorRect.right - MENU_WIDTH;
		}
		return Math.max(VIEWPORT_MARGIN, left);
	});

	function handleClickOutside(e: MouseEvent) {
		const target = e.target as Node;
		if (menuEl && !menuEl.contains(target)) {
			onClose();
		}
	}

	$effect(() => {
		document.addEventListener('mousedown', handleClickOutside, true);
		window.addEventListener('scroll', onClose, true);
		return () => {
			document.removeEventListener('mousedown', handleClickOutside, true);
			window.removeEventListener('scroll', onClose, true);
		};
	});

	function portal(node: HTMLElement) {
		document.body.appendChild(node);
		return {
			destroy() {
				node.remove();
			}
		};
	}
</script>

<div
	bind:this={menuEl}
	use:portal
	role="menu"
	tabindex="-1"
	style="position: fixed; top: {menuTop}px; left: {menuLeft}px; z-index: 9999; width: {MENU_WIDTH}px;"
	class="rounded-xl border border-base-content/10 bg-base-200/95 p-1.5 shadow-xl backdrop-blur-md"
	onclick={(e) => e.stopPropagation()}
	onkeydown={(e) => {
		if (e.key === 'Escape') onClose();
	}}
>
	<p class="px-3 py-1 text-[10px] font-semibold uppercase tracking-widest text-base-content/40">
		Play track
	</p>
	<button
		role="menuitem"
		class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium hover:bg-base-content/10 active:scale-[0.98]"
		onclick={() => { onPlayNow(); onClose(); }}
	>
		<CirclePlay class="h-4 w-4 text-warning" />
		Play Now
	</button>
	<button
		role="menuitem"
		class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium hover:bg-base-content/10 active:scale-[0.98]"
		onclick={() => { onPlayNext(); onClose(); }}
	>
		<Play class="h-4 w-4 text-primary" fill="currentColor" />
		Play Next
	</button>
	<button
		role="menuitem"
		class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium hover:bg-base-content/10 active:scale-[0.98]"
		onclick={() => { onAddToQueue(); onClose(); }}
	>
		<ListEnd class="h-4 w-4 text-base-content/60" />
		Add to Queue
	</button>
</div>
