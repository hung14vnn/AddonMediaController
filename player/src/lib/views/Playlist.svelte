<script lang="ts">
	import { cachedNow, deletePlaylist, getPlaylist, removeFromPlaylist } from '../api';
	import DetailHeader from '../components/DetailHeader.svelte';
	import ErrorState from '../components/ErrorState.svelte';
	import Icon from '../components/Icon.svelte';
	import TrackList from '../components/TrackList.svelte';
	import { plural, totalDuration } from '../format';
	import { playlistMenu } from '../menus';
	import { artworkTint } from '../palette';
	import { getPlayer } from '../player.svelte';
	import { router } from '../router.svelte';
	import type { Playlist, Song } from '../types';
	import { ui } from '../ui.svelte';

	let { id }: { id: string } = $props();
	const player = getPlayer();

	// Like the album page: the cover's tint colours the whole page on phones.
	// The tint is memoised per cover, so a revisit resolves synchronously when the cover does.
	function withTint(playlist: Playlist) {
		const tint = playlist.coverArt ? artworkTint(playlist.coverArt) : null;
		const assemble = (t: Awaited<typeof tint>) => ({ playlist, tint: t?.top ?? null });
		return tint instanceof Promise ? tint.then(assemble) : assemble(tint);
	}

	// Rendered from the on-device copy in the same frame; a changed playlist swaps in when it arrives.
	function load(playlistId: string) {
		const playlist = cachedNow(`playlist:${playlistId}`, () => getPlaylist(playlistId), {
			fresh: 0,
			refresh: (p) => (data = withTint(p))
		});
		return playlist instanceof Promise ? playlist.then(withTint) : withTint(playlist);
	}

	let data = $derived(load(id));

	async function remove(song: Song, index: number) {
		try {
			await removeFromPlaylist(id, [index]);
			ui.showToast(`Removed “${song.title}”`);
			data = load(id);
			ui.refreshPlaylists();
		} catch {
			ui.showToast('Couldn’t remove song');
		}
	}

	const menu = (playlist: Playlist) => [
		...playlistMenu(playlist),
		{ label: 'Delete Playlist', icon: 'trash', danger: true, action: () => destroy(playlist.name) }
	];

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
{:then { playlist, tint }}
	{@const songs = playlist.entry ?? []}
	<div class="page playlist-page" style:--hero-bg={tint}>
		<DetailHeader
			coverArt={playlist.coverArt}
			title={playlist.name}
			subtitle={playlist.owner}
			meta="{plural(songs.length, 'song')} · {totalDuration(songs)}"
			description={playlist.comment}
			icon="playlist"
			{songs}
			onmore={(e) => ui.openMenu(e, menu(playlist))}
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
						onclick={(e) => ui.openMenu(e, menu(playlist))}
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
	<ErrorState {error} retry={() => (data = load(id))} />
{/await}

<style>
	/* Same page background and text colours as the album page. */
	.playlist-page {
		--hero-bg: var(--bg);
	}
	@media (max-width: 899px) {
		.playlist-page {
			min-height: calc(100vh + 128px + env(safe-area-inset-bottom));
			background: var(--hero-bg);
			transition: background-color 0.4s ease;
		}
	}
	@media (max-width: 699px) {
		.playlist-page {
			color: #fff;
		}
		.playlist-page :global(.tracks .title),
		.playlist-page :global(.tracks .artist),
		.playlist-page :global(.tracks .duration),
		.playlist-page :global(.tracks .num),
		.playlist-page :global(.muted),
		.playlist-page :global(.more),
		.playlist-page :global(.empty-state) {
			color: #fff !important;
		}
	}
</style>