<script lang="ts">
	import { LoaderCircle, Play, ChevronDown, ListEnd, CirclePlay, Music } from 'lucide-svelte';
	import { ytMusicStreamer } from '$lib/stores/ytMusicStreamer.svelte';
	import { playerStore } from '$lib/stores/player.svelte';

	interface Props {
		artist: string;
		title: string;
		album?: string;
		size?: 'xs' | 'sm' | 'md';
		coverUrl?: string | null;
		wrapperClass?: string;
	}

	let { artist, title, album, size = 'sm', coverUrl = null, wrapperClass = '' }: Props = $props();

	const searchKey = $derived(`${artist}|${title}`);
	const active = $derived(
		ytMusicStreamer.activeKey === searchKey && ytMusicStreamer.status !== 'idle'
	);
	const loading = $derived(active && ytMusicStreamer.status === 'loading');

	// Separate menu state for the queue-action menu (triggered by play button when queue active)
	// and the playlist-only menu (triggered by chevron when no queue)
	let menuOpen = $state(false);
	let menuMode = $state<'full' | 'playlist-only'>('full');
	let anchorEl = $state<HTMLElement | null>(null);
	let menuEl = $state<HTMLDivElement | null>(null);
	let menuTop = $state(0);
	let menuLeft = $state(0);

	const MENU_WIDTH = 192;
	const VIEWPORT_MARGIN = 8;

	function computePosition(el: HTMLElement, estimatedHeight: number) {
		const rect = el.getBoundingClientRect();
		let top = rect.bottom + 6;
		let left = rect.left;

		if (left + MENU_WIDTH > window.innerWidth - VIEWPORT_MARGIN) {
			left = rect.right - MENU_WIDTH;
		}
		if (left < VIEWPORT_MARGIN) left = VIEWPORT_MARGIN;
		if (top + estimatedHeight > window.innerHeight - VIEWPORT_MARGIN) {
			top = rect.top - estimatedHeight - 6;
		}

		menuTop = top;
		menuLeft = left;
	}

	function handlePlay(e: MouseEvent) {
		e.stopPropagation();
		e.preventDefault();
		if (active) return;

		if (!playerStore.hasQueue) {
			// No queue → play immediately
			ytMusicStreamer.streamTrack(artist, title, 'playNow', album, coverUrl);
			return;
		}

		// Queue exists → show full menu from play button
		anchorEl = e.currentTarget as HTMLElement;
		computePosition(anchorEl, 200);
		menuMode = 'full';
		menuOpen = true;
	}

	function handleChevron(e: MouseEvent) {
		e.stopPropagation();
		e.preventDefault();
		// Show playlist-only mini menu
		anchorEl = e.currentTarget as HTMLElement;
		computePosition(anchorEl, 70);
		menuMode = 'playlist-only';
		menuOpen = true;
	}

	function closeMenu() {
		menuOpen = false;
	}

	function playNow(e: MouseEvent) {
		e.stopPropagation();
		// Replace the current track slot, keeping the rest of the queue
		ytMusicStreamer.streamTrack(artist, title, 'replaceCurrent', album, coverUrl);
		closeMenu();
	}

	function playNext(e: MouseEvent) {
		e.stopPropagation();
		ytMusicStreamer.streamTrack(artist, title, 'playNext', album, coverUrl);
		closeMenu();
	}

	function addToQueue(e: MouseEvent) {
		e.stopPropagation();
		ytMusicStreamer.streamTrack(artist, title, 'addToQueue', album, coverUrl);
		closeMenu();
	}

	async function addToPlaylist(e: MouseEvent) {
		e.stopPropagation();
		closeMenu();
		await ytMusicStreamer.streamTrack(artist, title, 'addToPlaylist', album, coverUrl);
	}

	function handleClickOutside(e: MouseEvent) {
		const target = e.target as Node;
		if (menuEl && !menuEl.contains(target) && anchorEl && !anchorEl.contains(target)) {
			closeMenu();
		}
	}

	$effect(() => {
		if (menuOpen) {
			document.addEventListener('click', handleClickOutside, true);
			window.addEventListener('scroll', closeMenu, true);
			return () => {
				document.removeEventListener('click', handleClickOutside, true);
				window.removeEventListener('scroll', closeMenu, true);
			};
		}
	});
</script>

<div class={wrapperClass ? wrapperClass : `flex items-center ${size === 'xs' ? 'gap-0.5' : 'gap-1'}`}>
	<!-- Play button -->
	<button
		type="button"
		class="relative {size === 'xs'
			? 'btn btn-ghost btn-circle btn-xs h-7 w-7 min-h-0 min-w-0'
			: `btn btn-circle btn-sm ${size === 'sm' ? 'min-h-[36px] min-w-[36px]' : 'min-h-[44px] min-w-[44px]'} border-none bg-base-content/20 shadow-sm hover:bg-base-content/30`} active:scale-[0.95]"
		title="Stream via YouTube Music"
		aria-label="Stream {title}"
		onclick={handlePlay}
		disabled={loading}
	>
		{#if loading}
			<LoaderCircle class="{size === 'xs' ? 'h-4 w-4' : 'h-4 w-4'} animate-spin" />
		{:else}
			<Play class={size === 'xs' ? 'h-4 w-4 ml-0.5' : 'h-4 w-4'} fill="currentColor" />
		{/if}
	</button>

	<!-- Chevron button: only shown when no queue (for playlist access) -->
	{#if !playerStore.hasQueue}
		<button
			type="button"
			class="{size === 'xs'
				? 'btn btn-ghost btn-xs h-5 w-4 min-h-0 min-w-0 rounded px-0'
				: 'btn btn-ghost btn-sm h-5 w-4 min-h-0 min-w-0 rounded px-0'} opacity-50 hover:opacity-100 -ml-0.5"
			title="More options"
			aria-label="More stream options for {title}"
			onclick={handleChevron}
			disabled={loading}
		>
			<ChevronDown class="h-3 w-3" />
		</button>
	{/if}
</div>

{#if menuOpen}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div
		bind:this={menuEl}
		role="menu"
		tabindex="-1"
		style="position: fixed; top: {menuTop}px; left: {menuLeft}px; z-index: 9999; width: {MENU_WIDTH}px;"
		class="rounded-xl border border-base-content/10 bg-base-200/95 p-1.5 shadow-xl backdrop-blur-md"
		onclick={(e) => e.stopPropagation()}
		onkeydown={(e) => { if (e.key === 'Escape') closeMenu(); }}
	>
		{#if menuMode === 'full'}
			<p class="px-3 py-1 text-[10px] font-semibold uppercase tracking-widest text-base-content/40">
				Stream via YouTube
			</p>
			<button
				role="menuitem"
				class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium hover:bg-base-content/10 active:scale-[0.98]"
				onclick={playNow}
			>
				<CirclePlay class="h-4 w-4 text-warning" />
				Play Now
			</button>
			<button
				role="menuitem"
				class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium hover:bg-base-content/10 active:scale-[0.98]"
				onclick={playNext}
			>
				<Play class="h-4 w-4 text-primary" fill="currentColor" />
				Play Next
			</button>
			<button
				role="menuitem"
				class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium hover:bg-base-content/10 active:scale-[0.98]"
				onclick={addToQueue}
			>
				<ListEnd class="h-4 w-4 text-base-content/60" />
				Add to Queue
			</button>
			<div class="my-1 border-t border-base-content/10"></div>
		{/if}
		<button
			role="menuitem"
			class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium hover:bg-base-content/10 active:scale-[0.98]"
			onclick={addToPlaylist}
		>
			<Music class="h-4 w-4 text-base-content/50" />
			Add to Playlist
		</button>
	</div>
{/if}
