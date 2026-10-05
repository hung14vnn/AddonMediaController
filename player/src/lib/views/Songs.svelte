<script lang="ts">
import { getAllSongs, getSongsByGenre, getSession } from '../api';
	import { untrack } from 'svelte';
	import ErrorState from '../components/ErrorState.svelte';
	import Icon from '../components/Icon.svelte';
	import Sentinel from '../components/Sentinel.svelte';
	import SortMenu from '../components/SortMenu.svelte';
	import TrackList from '../components/TrackList.svelte';
	import { getPlayer } from '../player.svelte';
import { router } from '../router.svelte';
import { listOfflineTrackMetadata } from '../offline';
	import type { Song } from '../types';

	const PAGE = 100;
	let { genre }: { genre?: string } = $props();
	const player = getPlayer();

	let songs = $state<Song[]>([]);
	let done = $state(false);
	let loading = $state(false);
	let error = $state<unknown>(null);
	let query = $state('');
	let sort = $state<'title' | 'artist' | 'album' | 'added' | 'played'>('title');
	let downloadedIds = $state(new Set<string>());

	function fold(value: string): string {
		return value
			.normalize('NFD')
			.replace(/[\u0300-\u036f]/g, '')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, ' ')
			.trim();
	}

	function editDistance(a: string, b: string): number {
		const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
		for (let i = 1; i <= a.length; i++) {
			let diagonal = previous[0];
			previous[0] = i;
			for (let j = 1; j <= b.length; j++) {
				const old = previous[j];
				previous[j] = a[i - 1] === b[j - 1]
					? diagonal
					: 1 + Math.min(diagonal, previous[j], previous[j - 1]);
				diagonal = old;
			}
		}
		return previous[b.length];
	}

	function fuzzyMatch(song: Song, term: string): boolean {
		const fields = [song.title, song.artist, song.album]
			.filter(Boolean)
			.map((value) => fold(value ?? ''));
		const queryWords = term.split(' ').filter(Boolean);
		const fieldWords = fields.flatMap((value) => value.split(' '));
		if (!queryWords.length || !fieldWords.length) return false;

		const score = queryWords.reduce((total, word) => {
			const best = Math.max(
				...fieldWords.map((candidate) => {
					const distance = editDistance(word, candidate);
					return 1 - distance / Math.max(word.length, candidate.length);
				})
			);
			return total + best;
		}, 0) / queryWords.length;

		// Short words need a stricter threshold to avoid too many unrelated songs.
		const threshold = term.replaceAll(' ', '').length <= 4 ? 0.8 : 0.68;
		return score >= threshold;
	}

	// The filter runs on a debounced, pre-folded term, so typing doesn't re-filter
	// (and possibly fuzzy-match) the whole library on every keystroke.
	const FILTER_DEBOUNCE_MS = 200;
	let term = $state('');
	$effect(() => {
		const next = fold(query);
		if (!next) return void (term = ''); // clearing the box is instant
		const timer = setTimeout(() => (term = next), FILTER_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	});

	const foldedText = new WeakMap<Song, string>();
	function searchText(song: Song): string {
		let text = foldedText.get(song);
		if (text === undefined) {
			text = fold(`${song.title} ${song.artist ?? ''} ${song.album ?? ''}`);
			foldedText.set(song, text);
		}
		return text;
	}

	// Sorting only depends on the songs and the sort key, not on the filter;
	// filtering a sorted list keeps its order.
	const sortedSongs = $derived(
		[...songs].sort((a, b) => {
			if (sort === 'artist') return (a.artist ?? '').localeCompare(b.artist ?? '');
			if (sort === 'album') return (a.album ?? '').localeCompare(b.album ?? '');
			if (sort === 'added' || sort === 'played') return String((b as any)[sort === 'added' ? 'created' : 'lastPlayed'] ?? '').localeCompare(String((a as any)[sort === 'added' ? 'created' : 'lastPlayed'] ?? ''));
			return a.title.localeCompare(b.title);
		})
	);

	const visibleSongs = $derived.by(() => {
		if (!term) return sortedSongs;
		const exact = sortedSongs.filter((song) => searchText(song).includes(term));
		return exact.length ? exact : sortedSongs.filter((song) => fuzzyMatch(song, term));
	});

	// ---- windowing --------------------------------------------------------------
	// Only rows near the viewport are in the DOM; spacers stand in for the rest, so
	// a long scroll through the library doesn't pile up thousands of rows/images.
	const OVERSCAN = 20; // rows rendered beyond each edge of the viewport
	const CHUNK = 10; // move the window in steps, not on every scrolled row
	let listEl = $state<HTMLElement>();
	let rowHeight = $state(56);
	let windowStart = $state(0);
	let windowEnd = $state(80);
	// Once the window has moved, rows mounted by scrolling shouldn't replay the
	// staggered reveal animation.
	let scrolled = $state(false);
	const windowSongs = $derived(visibleSongs.slice(windowStart, windowEnd));

	$effect(() => {
		const el = listEl;
		void visibleSongs.length; // re-measure when the list grows or is filtered
		if (!el) return;
		const scroller = el.closest('main') ?? document.documentElement;
		let frame = 0;
		const update = () => {
			frame = 0;
			const row = el.querySelector<HTMLElement>('.row');
			if (row?.offsetHeight) rowHeight = row.offsetHeight;
			const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
			const first = Math.floor(-top / rowHeight);
			const start = Math.max(0, Math.floor((first - OVERSCAN) / CHUNK) * CHUNK);
			const end = start + Math.ceil(scroller.clientHeight / rowHeight) + 2 * OVERSCAN + CHUNK;
			if (start !== windowStart || end !== windowEnd) {
				if (start !== windowStart) scrolled = true;
				windowStart = start;
				windowEnd = end;
			}
		};
		const schedule = () => (frame ||= requestAnimationFrame(update));
		scroller.addEventListener('scroll', schedule, { passive: true });
		addEventListener('resize', schedule);
		untrack(update); // reads/writes window state; must not subscribe to it
		return () => {
			cancelAnimationFrame(frame);
			scroller.removeEventListener('scroll', schedule);
			removeEventListener('resize', schedule);
		};
	});

	async function more() {
		if (loading || done) return;
		loading = true;
		try {
			const page = genre ? await getSongsByGenre(genre, PAGE, songs.length) : await getAllSongs(songs.length, PAGE);
			songs.push(...page);
			if (page.length < PAGE) done = true;
		} catch (e) {
			error = e;
			done = true;
		} finally {
			loading = false;
		}
	}

	async function shuffle() {
		player.playList(visibleSongs, 0, { shuffle: true });
	}

	more();
	const username = getSession()?.username;
	if (username) listOfflineTrackMetadata(username).then((tracks) => (downloadedIds = new Set(tracks.map((track) => track.trackId))));
</script>

<div class="page">
	<div class="head">
		<button class="back" onclick={() => router.go('/library')}><Icon name="chevronLeft" size={18} />Library</button>
		<SortMenu
			value={sort}
			options={[
				{ value: 'title', label: 'Title' },
				{ value: 'artist', label: 'Artist' },
				{ value: 'album', label: 'Album' },
				{ value: 'added', label: 'Recently Added' },
				{ value: 'played', label: 'Recently Played' }
			]}
			onchange={(value) => (sort = value as typeof sort)}
		/>
	</div>
	{#if !genre}<h1 class="page-title">Songs</h1>{/if}
	<div class="tools">
		<label class="search"><Icon name="search" size={16} /><input type="search" placeholder="Search songs…" bind:value={query} /></label>
	</div>
	{#if error && !songs.length}
		<ErrorState {error} />
	{:else if done && !songs.length}
		<div class="empty-state"><h3>No Songs</h3></div>
	{:else}
		<div class="pad actions bar">
			<button class="btn" disabled={!visibleSongs.length} onclick={() => player.playList(visibleSongs)}><Icon name="play" size={16} />Play</button>
			<button class="btn" disabled={!visibleSongs.length} onclick={shuffle}><Icon name="shuffle" size={16} />Shuffle</button>
		</div>
		<div
			class="pad"
			class:scrolled
			bind:this={listEl}
			style:padding-top="{Math.min(windowStart, visibleSongs.length) * rowHeight}px"
			style:padding-bottom="{Math.max(0, visibleSongs.length - windowEnd) * rowHeight}px"
		>
			<TrackList
				songs={windowSongs}
				{downloadedIds}
				onplay={(i) => player.playList(visibleSongs, windowStart + i)}
			/>
		</div>
		{#if !done}<Sentinel onvisible={more} {loading} />{/if}
	{/if}
</div>

<style>
	.bar {
		margin-bottom: 16px;
	}
	.scrolled :global(.tracks > .row) {
		animation: none;
	}
	.head { display: flex; align-items: center; gap: 12px; padding: 0 var(--gutter); margin-bottom: 8px; }
	.back { display: inline-flex; align-items: center; gap: 2px; color: var(--accent); font-size: 14px; }
	.tools { display: flex; gap: 10px; align-items: center; margin: 0 var(--gutter) 16px; }
	.search { flex: 1; display: flex; align-items: center; gap: 8px; padding: 8px 10px; color: var(--text-2); background: var(--fill); border-radius: 9px; }
	.search input { min-width: 0; width: 100%; border: 0; outline: 0; background: none; color: var(--text); font: inherit; }
</style>
