<script lang="ts">
	import { getPlaylist } from "../api";
	import { playlistMenu, songMenu } from "../menus";
	import { getPlayer } from "../player.svelte";
	import { href } from "../router.svelte";
	import type { Playlist, Song } from "../types";
	import { ui } from "../ui.svelte";
	import Icon from "./Icon.svelte";
	import Artwork from "./Artwork.svelte";

	let { playlist }: { playlist: Playlist } = $props();
	let songs: Song[] = $state([]);
	let loading = $state(true);

	$effect(() => {
		getPlaylist(playlist.id)
			.then((p) => {
				if (p.entry) songs = p.entry;
				loading = false;
			})
			.catch(() => {
				loading = false;
			});
	});

	async function play() {
		const toPlay = songs.length
			? songs
			: (playlist.entry ?? (await getPlaylist(playlist.id)).entry ?? []);
		if (toPlay.length) {
			getPlayer().playList(toPlay);
		}
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="radio-card"
	oncontextmenu={(e) => ui.openMenu(e, playlistMenu(playlist))}
>
	<a class="header" href={href.playlist(playlist.id)}>
		<div class="header-cover">
			<Artwork
				id={playlist.coverArt}
				seed={playlist.name}
				icon="radio"
				size={80}
			/>
			<div class="play-overlay">
				<Icon name="play" size={32} />
			</div>
		</div>
		<div class="header-info">
			<h3>{playlist.name}</h3>
			<p>{playlist.owner}</p>
		</div>
	</a>

	<div class="tracks">
		{#if !loading && songs.length > 0}
			{#each songs.slice(0, 3) as song}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="track"
					oncontextmenu={(e) => {
						e.stopPropagation();
						ui.openMenu(e, songMenu(song));
					}}
					onclick={(e) => {
						e.preventDefault();
						getPlayer().playList([song]);
					}}
				>
					<div class="track-cover">
						<Artwork
							id={song.coverArt}
							seed={song.title}
							icon="note"
							size={40}
						/>
					</div>
					<div class="track-info">
						<div class="track-title clamp">{song.title}</div>
						<div class="track-artist clamp">
							{song.artist}
						</div>
					</div>
					<button
						class="more-btn"
						aria-label="More"
						onclick={(e) => {
							e.preventDefault();
							e.stopPropagation();
							ui.openMenu(e, songMenu(song));
						}}
					>
						<Icon name="more" size={18} />
					</button>
				</div>
			{/each}
		{:else if loading}
			{#each Array(3) as _}
				<div class="track skeleton">
					<div class="track-cover-skeleton"></div>
					<div class="track-info-skeleton">
						<div class="line"></div>
						<div class="line short"></div>
					</div>
				</div>
			{/each}
		{/if}
	</div>

	<div class="actions">
		<button
			class="action-btn play-btn"
			aria-label="Play"
			onclick={(e) => {
				e.preventDefault();
				play();
			}}
		>
			<Icon name="play" size={20} />
		</button>
		<button
			class="action-btn"
			aria-label="Save"
			onclick={(e) => {
				e.preventDefault();
				ui.openMenu(e, playlistMenu(playlist));
			}}
		>
			<Icon name="queue" size={20} />
		</button>
	</div>
</div>

<style>
	.radio-card {
		background: var(--surface, rgba(255, 255, 255, 0.04));
		border-radius: 12px;
		padding: 12px;
		display: flex;
		flex-direction: column;
		gap: 12px;
		width: 100%;
		transition: background 0.2s;
	}
	.radio-card:hover {
		background: var(--surface-hover, rgba(255, 255, 255, 0.08));
	}

	.header {
		display: flex;
		gap: 12px;
		align-items: center;
		color: inherit;
		text-decoration: none;
	}
	.header-cover {
		position: relative;
		width: 80px;
		height: 80px;
		border-radius: 8px;
		overflow: hidden;
		flex-shrink: 0;
	}
	.play-overlay {
		position: absolute;
		inset: 0;
		background: rgba(0, 0, 0, 0.4);
		display: flex;
		align-items: center;
		justify-content: center;
		opacity: 0;
		transition: opacity 0.2s;
		color: #fff;
	}
	.header-cover:hover .play-overlay {
		opacity: 1;
	}
	.header-info {
		display: flex;
		flex-direction: column;
		gap: 4px;
		overflow: hidden;
	}
	.header-info h3 {
		margin: 0;
		font-size: 18px;
		font-weight: 700;
		color: var(--text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.header-info p {
		margin: 0;
		font-size: 13px;
		color: var(--text-2);
	}

	.tracks {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.track {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 6px;
		border-radius: 6px;
		cursor: pointer;
		background: transparent;
		transition: background 0.2s;
	}
	.track:hover {
		background: rgba(255, 255, 255, 0.05);
	}
	.track-cover {
		width: 40px;
		height: 40px;
		border-radius: 4px;
		overflow: hidden;
		flex-shrink: 0;
	}
	.track-info {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.track-title {
		font-size: 14px;
		font-weight: 500;
		color: var(--text);
	}
	.track-artist {
		font-size: 12px;
		color: var(--text-2);
		display: flex;
		align-items: center;
		gap: 4px;
	}
	.clamp {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.more-btn {
		background: transparent;
		border: none;
		color: var(--text-2);
		padding: 8px;
		cursor: pointer;
		opacity: 0;
		transition:
			opacity 0.2s,
			color 0.2s;
	}
	.track:hover .more-btn {
		opacity: 1;
	}
	.more-btn:hover {
		color: var(--text);
	}

	.skeleton .track-cover-skeleton {
		width: 40px;
		height: 40px;
		border-radius: 4px;
		background: var(--hairline);
		animation: pulse 1.5s infinite;
	}
	.skeleton .track-info-skeleton {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 6px;
		justify-content: center;
	}
	.skeleton .line {
		height: 10px;
		background: var(--hairline);
		border-radius: 4px;
		width: 80%;
		animation: pulse 1.5s infinite;
	}
	.skeleton .line.short {
		width: 50%;
	}

	@keyframes pulse {
		0% {
			opacity: 0.6;
		}
		50% {
			opacity: 0.3;
		}
		100% {
			opacity: 0.6;
		}
	}

	.actions {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-top: auto;
		padding-top: 4px;
	}
	.action-btn {
		width: 40px;
		height: 40px;
		border-radius: 50%;
		border: none;
		background: rgba(255, 255, 255, 0.1);
		color: var(--text);
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		transition:
			transform 0.15s,
			background 0.15s;
	}
	.action-btn:hover {
		background: rgba(255, 255, 255, 0.2);
		transform: scale(1.05);
	}
	.play-btn {
		background: #ffffff;
		color: #000000;
	}
	.play-btn:hover {
		background: #e5e5e5;
	}
	.play-btn :global(svg) {
		margin-left: 2px;
	}
</style>
