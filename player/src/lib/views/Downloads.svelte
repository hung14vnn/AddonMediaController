<script lang="ts">
	import { getSession } from '../api';
	import { listOfflineTrackMetadata, deleteOfflineTrack, type OfflineTrackMetadata } from '../offline';
	import ErrorState from '../components/ErrorState.svelte';
	import Icon from '../components/Icon.svelte';
	import TrackList from '../components/TrackList.svelte';
	import { getPlayer } from '../player.svelte';
	import type { Song } from '../types';
import { router } from '../router.svelte';

	const player = getPlayer();
	let tracks = $state<OfflineTrackMetadata[]>([]);
	let loading = $state(true);
	let error = $state<unknown>(null);
	let query = $state('');

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

	const songs = $derived(
		tracks
			.filter((track) => `${track.title} ${track.artistName} ${track.albumName}`.toLowerCase().includes(query.toLowerCase()))
			.map(toSong)
	);

	async function remove(song: Song) {
		const username = getSession()?.username;
		if (!username) return;
		await deleteOfflineTrack(username, song.id);
		tracks = tracks.filter((track) => track.trackId !== song.id);
	}

	load();
</script>

<div class="page">
	<div class="head"><button class="back" onclick={() => router.go('/library')}><Icon name="chevronLeft" size={18} />Library</button></div>
	<h1 class="page-title">Downloaded</h1>
	{#if loading}
		<div class="spinner"></div>
	{:else if error}
		<ErrorState {error} retry={load} />
	{:else if !tracks.length}
		<div class="empty-state"><Icon name="download" size={42} /><h3>No Downloaded Songs</h3><p>Download songs from their More menu to listen offline.</p></div>
	{:else}
		<div class="tools">
			<label class="search"><Icon name="search" size={16} /><input type="search" placeholder="Search downloads…" bind:value={query} /></label>
			<button class="btn" disabled={!songs.length} onclick={() => player.playList(songs)}><Icon name="play" size={16} />Play</button>
		</div>
		<div class="pad"><TrackList songs={songs} /></div>
	{/if}
</div>

<style>
	.tools { display: flex; gap: 10px; align-items: center; margin: 0 var(--gutter) 16px; }
	.search { flex: 1; display: flex; align-items: center; gap: 8px; padding: 8px 10px; color: var(--text-2); background: var(--fill); border-radius: 9px; }
	.search input { min-width: 0; width: 100%; border: 0; outline: 0; background: none; color: var(--text); font: inherit; }
	.empty-state p { color: var(--text-2); }
	.head { display: flex; align-items: center; padding: 0 var(--gutter); margin-bottom: 8px; }
	.back { display: inline-flex; align-items: center; gap: 2px; color: var(--accent); font-size: 14px; }
</style>
