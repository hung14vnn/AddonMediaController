<script lang="ts">
import { getAllSongs, getSongsByGenre, getSession } from '../api';
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
	const visibleSongs = $derived(
		songs
			.filter((song) => `${song.title} ${song.artist ?? ''} ${song.album ?? ''}`.toLowerCase().includes(query.toLowerCase()))
			.sort((a, b) => {
				if (sort === 'artist') return (a.artist ?? '').localeCompare(b.artist ?? '');
				if (sort === 'album') return (a.album ?? '').localeCompare(b.album ?? '');
				if (sort === 'added' || sort === 'played') return String((b as any)[sort === 'added' ? 'created' : 'lastPlayed'] ?? '').localeCompare(String((a as any)[sort === 'added' ? 'created' : 'lastPlayed'] ?? ''));
				return a.title.localeCompare(b.title);
			})
	);

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
		<div class="pad"><TrackList songs={visibleSongs} {downloadedIds} /></div>
		{#if !done}<Sentinel onvisible={more} {loading} />{/if}
	{/if}
</div>

<style>
	.bar {
		margin-bottom: 16px;
	}
	.head { display: flex; align-items: center; gap: 12px; padding: 0 var(--gutter); margin-bottom: 8px; }
	.back { display: inline-flex; align-items: center; gap: 2px; color: var(--accent); font-size: 14px; }
	.tools { display: flex; gap: 10px; align-items: center; margin: 0 var(--gutter) 16px; }
	.search { flex: 1; display: flex; align-items: center; gap: 8px; padding: 8px 10px; color: var(--text-2); background: var(--fill); border-radius: 9px; }
	.search input { min-width: 0; width: 100%; border: 0; outline: 0; background: none; color: var(--text); font: inherit; }
</style>
