<script lang="ts">
	import { deletePlaylist, getPlaylist, removeFromPlaylist } from '../api';
	import DetailHeader from '../components/DetailHeader.svelte';
	import ErrorState from '../components/ErrorState.svelte';
	import Icon from '../components/Icon.svelte';
	import TrackList from '../components/TrackList.svelte';
	import { plural, totalDuration } from '../format';
	import { playlistMenu } from '../menus';
	import { getPlayer } from '../player.svelte';
	import { router } from '../router.svelte';
	import type { Song } from '../types';
	import { ui } from '../ui.svelte';

	let { id }: { id: string } = $props();
	const player = getPlayer();

	let data = $derived(getPlaylist(id));

	async function remove(song: Song, index: number) {
		try {
			await removeFromPlaylist(id, [index]);
			ui.showToast(`Removed “${song.title}”`);
			data = getPlaylist(id);
			ui.refreshPlaylists();
		} catch {
			ui.showToast('Couldn’t remove song');
		}
	}

	async function destroy(name: string) {
		if (!confirm(`Delete “${name}”? This can’t be undone.`)) return;
		try {
			await deletePlaylist(id);
			ui.showToast(`Deleted “${name}”`);
			await ui.refreshPlaylists();
			router.go('/playlists', true);
		} catch {
			ui.showToast('Couldn’t delete playlist');
		}
	}
</script>

{#await data}
	<div class="spinner"></div>
{:then playlist}
	{@const songs = playlist.entry ?? []}
	<div class="page">
		<DetailHeader
			coverArt={playlist.coverArt}
			title={playlist.name}
			subtitle={playlist.owner}
			meta="{plural(songs.length, 'song')} · {totalDuration(songs)}"
			description={playlist.comment}
			icon="playlist"
		>
			{#snippet actions()}
				<div class="actions">
					<button class="btn" disabled={!songs.length} onclick={() => player.playList(songs)}><Icon name="play" size={16} />Play</button>
					<button class="btn" disabled={!songs.length} onclick={() => player.playList(songs, 0, { shuffle: true })}>
						<Icon name="shuffle" size={16} />Shuffle
					</button>
					<button
						class="btn icon-only"
						aria-label="More options"
						onclick={(e) =>
							ui.openMenu(e, [
								...playlistMenu(playlist),
								{ label: 'Delete Playlist', icon: 'trash', danger: true, action: () => destroy(playlist.name) }
							])}
					>
						<Icon name="more" size={18} />
					</button>
				</div>
			{/snippet}
		</DetailHeader>

		{#if songs.length}
			<div class="pad">
				<TrackList
					{songs}
					extraMenu={(song, i) => [{ label: 'Remove from Playlist', icon: 'trash', danger: true, action: () => remove(song, i) }]}
				/>
			</div>
		{:else}
			<div class="empty-state">
				<Icon name="playlist" size={44} />
				<h3>This playlist is empty</h3>
				<p>Use “Add to Playlist…” on any song or album.</p>
			</div>
		{/if}
	</div>
{:catch error}
	<ErrorState {error} retry={() => (data = getPlaylist(id))} />
{/await}