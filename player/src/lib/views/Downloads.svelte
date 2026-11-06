<script lang="ts">
	import { getSession } from '../api';
	import { deleteOfflineTracks, listOfflineTrackMetadata, type OfflineTrackMetadata } from '../offline';
	import ErrorState from '../components/ErrorState.svelte';
	import Icon from '../components/Icon.svelte';
	import TrackList from '../components/TrackList.svelte';
	import { getPlayer } from '../player.svelte';
	import type { Song } from '../types';
	import { ui } from '../ui.svelte';
import { router } from '../router.svelte';
	import { SvelteSet } from 'svelte/reactivity';

	const player = getPlayer();
	let tracks = $state<OfflineTrackMetadata[]>([]);
	let loading = $state(true);
	let error = $state<unknown>(null);
	let query = $state('');
	let selecting = $state(false);
	let selected = new SvelteSet<string>();
	let removing = $state(false);

	async function load() {
		const username = getSession()?.username;
		if (!username) return;
		loading = true;
		try {
			tracks = await listOfflineTrackMetadata(username);
		} catch (e) {
			error = e;
		} finally {
			loading = false;
		}
	}

	function toSong(track: OfflineTrackMetadata): Song {
		return {
			id: track.trackId,
			title: track.title,
			artist: track.artistName,
			album: track.albumName,
			albumId: track.albumId,
			artistId: track.artistId,
			coverArt: track.coverUrl ?? undefined,
			track: track.trackNumber,
			discNumber: track.discNumber ?? undefined,
			duration: track.durationSeconds ?? undefined,
			suffix: track.format
		};
	}

	const allSongs = $derived(tracks.map(toSong));
	const songs = $derived(
		allSongs.filter((song) =>
			`${song.title} ${song.artist ?? ''} ${song.album ?? ''}`.toLowerCase().includes(query.toLowerCase())
		)
	);

	const selectedSongs = $derived(allSongs.filter((song) => selected.has(song.id)));
	const allSelected = $derived(songs.length > 0 && songs.every((song) => selected.has(song.id)));

	function startSelection(song: Song) {
		selecting = true;
		selected.clear();
		selected.add(song.id);
	}

	function toggleSelect() {
		selecting = !selecting;
		if (!selecting) selected.clear();
	}

	function toggleSong(song: Song) {
		if (selected.has(song.id)) selected.delete(song.id);
		else selected.add(song.id);
	}

	function toggleAll() {
		// "Deselect All" clears selections the filter is hiding too.
		if (allSelected) selected.clear();
		else songs.forEach((song) => selected.add(song.id));
	}

	async function removeSelected() {
		const username = getSession()?.username;
		if (!username || removing || !selectedSongs.length) return;
		removing = true;
		try {
			const removed = await deleteOfflineTracks(username, selectedSongs.map((song) => song.id));
			if (removed.length) {
				const gone = new Set(removed);
				tracks = tracks.filter((track) => !gone.has(track.trackId));
				ui.showToast(
					removed.length === 1 ? 'Removed 1 download' : `Removed ${removed.length} downloads`
				);
			} else {
				ui.showToast('Couldn’t remove downloads');
			}
			selecting = false;
			selected.clear();
		} finally {
			removing = false;
		}
	}

	load();
</script>

<div class="page">
	<div class="head">
		<button class="back" onclick={() => router.go('/library')}><Icon name="chevronLeft" size={18} />Library</button>
		<button class="select-btn" class:shown={selecting} inert={!selecting} onclick={toggleSelect}>Done</button>
	</div>
	<h1 class="page-title">Downloaded</h1>
	{#if loading}
		<div class="spinner"></div>
	{:else if error}
		<ErrorState {error} retry={load} />
	{:else if !tracks.length}
		<div class="empty-state"><Icon name="download" size={42} /><h3>No Downloaded Songs</h3><p>Download songs from their More menu, or hold one in Songs to pick several.</p></div>
	{:else}
		<div class="tools">
			<label class="search"><Icon name="search" size={16} /><input type="search" placeholder="Search downloads…" bind:value={query} /></label>
		</div>
		<div class="pad actions bar">
			{#if selecting}
				<button class="btn" disabled={!selectedSongs.length || removing} onclick={removeSelected}>
					<Icon name="trash" size={16} />{selectedSongs.length ? `Remove ${selectedSongs.length}` : 'Remove'}
				</button>
				<button class="btn secondary" disabled={!songs.length} onclick={toggleAll}>
					{allSelected ? 'Deselect All' : 'Select All'}
				</button>
			{:else}
				<button class="btn" disabled={!songs.length} onclick={() => player.playList(songs)}><Icon name="play" size={16} />Play</button>
			{/if}
		</div>
		<div class="pad">
			<TrackList
				songs={songs}
				selectionMode={selecting}
				selectedIds={selected}
				onselect={toggleSong}
				onhold={startSelection}
			/>
		</div>
	{/if}
</div>

<style>
	.tools { display: flex; gap: 10px; align-items: center; margin: 0 var(--gutter) 16px; }
	.search { flex: 1; display: flex; align-items: center; gap: 8px; padding: 8px 10px; color: var(--text-2); background: var(--fill); border-radius: 9px; }
	.search input { min-width: 0; width: 100%; border: 0; outline: 0; background: none; color: var(--text); font: inherit; }
	.empty-state p { color: var(--text-2); }
	.head { display: flex; align-items: center; justify-content: space-between; padding: 0 var(--gutter); margin-bottom: 8px; }
	.back { display: inline-flex; align-items: center; gap: 2px; color: var(--accent); font-size: 14px; }
	.select-btn {
		display: inline-flex;
		align-items: center;
		height: 32px;
		padding: 0 2px;
		color: var(--accent);
		font-size: 15px;
		font-weight: 600;
		white-space: nowrap;
		opacity: 0;
		transform: scale(0.96);
		pointer-events: none;
		transition: opacity 0.16s ease, transform 0.16s ease;
	}
	.select-btn.shown { opacity: 1; transform: none; pointer-events: auto; }
	.bar { margin-bottom: 16px; }
	@media (prefers-reduced-motion: reduce) {
		.select-btn { transition: none; }
	}
</style>
