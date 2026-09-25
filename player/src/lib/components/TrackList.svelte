<script lang="ts">
	import { artistName, time } from '../format';
	import { songMenu } from '../menus';
	import { getPlayer } from '../player.svelte';
	import { href } from '../router.svelte';
	import type { Song } from '../types';
	import { pop } from '../motion';
	import { ui, type MenuItem } from '../ui.svelte';
	import Artwork from './Artwork.svelte';
	import Icon from './Icon.svelte';

	let {
		songs,
		variant = 'list',
		albumArtist,
		showAlbum = true,
		onplay,
		extraMenu,
		downloadedIds = new Set<string>()
	}: {
		songs: Song[];
		/** 'album' = numbered rows without art; 'list' = artwork thumbnails. */
		variant?: 'album' | 'list';
		albumArtist?: string;
		showAlbum?: boolean;
		onplay?: (index: number) => void;
		extraMenu?: (song: Song, index: number) => MenuItem[];
		downloadedIds?: Set<string>;
	} = $props();

	const player = getPlayer();
	const multiDisc = $derived(variant === 'album' && new Set(songs.map((s) => s.discNumber ?? 1)).size > 1);

	function play(i: number) {
		if (onplay) onplay(i);
		else player.playList(songs, i);
	}

	function menu(e: MouseEvent, song: Song, i: number) {
		ui.openMenu(e, songMenu(song, extraMenu?.(song, i) ?? []));
	}
</script>

<div class="tracks v-{variant}" class:no-album={!showAlbum} role="list">
	{#each songs as song, i (song.id + ':' + i)}
		{#if multiDisc && (i === 0 || (songs[i - 1].discNumber ?? 1) !== (song.discNumber ?? 1))}
			<div class="disc">Disc {song.discNumber ?? 1}</div>
		{/if}
		{@const current = player.current?.id === song.id}
		{@const loved = ui.isLoved(song)}
		<div
			class="row"
			class:current
			role="listitem"
			ondblclick={() => play(i)}
			oncontextmenu={(e) => menu(e, song, i)}
		>
			<button class="lead" aria-label="Play {song.title}" onclick={() => play(i)}>
				{#if variant === 'list'}
					<span class="thumb">
						<Artwork id={song.coverArt} size={64} seed={song.album ?? song.title} />
						{#if current}
							<span class="thumb-overlay">
								<span class="bars" class:paused={!player.playing}><i></i><i></i><i></i></span>
							</span>
						{/if}
					</span>
				{:else if current}
					<span class="bars" class:paused={!player.playing}><i></i><i></i><i></i></span>
				{:else}
					<!-- TỐI ƯU 1: Bọc nút Play và số thứ tự vào cùng 1 wrapper tĩnh để chống Reflow -->
					<span class="lead-stack">
						<span class="num">{song.track ?? i + 1}</span>
						<Icon name="play" size={14} class="hover-play" />
					</span>
				{/if}
			</button>
			<button class="main" onclick={() => play(i)} tabindex="-1">
				<span class="title">
					<span class="ellipsis">{song.title}</span>
					{#if song.explicitStatus === 'explicit'}<span class="explicit" aria-label="Explicit">E</span>{/if}
				</span>
				{#if variant === 'list' || (albumArtist && artistName(song) !== albumArtist)}
					<span class="artist ellipsis">{artistName(song)}</span>
				{/if}
			</button>
			{#if variant === 'list' && showAlbum}
				{#if song.albumId}
					<a class="album-col ellipsis" href={href.album(song.albumId)}>{song.album}</a>
				{:else}
					<span class="album-col ellipsis">{song.album ?? ''}</span>
				{/if}
			{/if}
			<span class="love" class:on={loved}>
				{#if downloadedIds.has(song.id)}
					<span class="downloaded" aria-label="Downloaded"><Icon name="download" size={12} /></span>
				{:else if loved}
					<span class="icon-swap" in:pop={{ from: 0.2, duration: 300 }}>
						<Icon name="starFill" size={14} />
					</span>
				{/if}
			</span>
			<span class="duration">{time(song.duration)}</span>
			<button class="more" aria-label="More options for {song.title}" onclick={(e) => menu(e, song, i)}>
				<Icon name="more" size={20} />
			</button>
		</div>
	{/each}
</div>

<style>
	.tracks {
		display: flex;
		flex-direction: column;
	}
	.disc {
		font-size: 13px;
		font-weight: 600;
		color: var(--text-2);
		padding: 18px 10px 6px;
	}
	.row {
		display: grid;
		grid-template-columns: 36px minmax(0, 1.4fr) 20px 52px 32px;
		align-items: center;
		gap: 8px;
		min-height: 48px;
		padding: 0 6px 0 4px;
		border-radius: 8px;
		position: relative;
		transition: background-color 0.12s ease;
		/* Giúp GPU render danh sách cuộn cực nhẹ */
		contain: content;
	}
	.v-list .row {
		grid-template-columns: 44px minmax(0, 1.4fr) minmax(0, 1fr) 20px 52px 32px;
		min-height: 56px;
	}
	.v-list.no-album .row {
		grid-template-columns: 44px minmax(0, 1fr) 20px 52px 32px;
	}
	.v-album .row:nth-child(even of .row) {
		background: var(--stripe);
	}
	.v-list .row::after {
		content: '';
		position: absolute;
		left: 56px;
		right: 0;
		bottom: 0;
		border-bottom: 0.5px solid var(--hairline);
	}

	/* TỐI ƯU 2: Thay opacity/visibility thay vì display: none/block để tránh tính toán lại Layout (Reflow) */
	.lead-stack {
		display: grid;
		place-items: center;
		width: 100%;
		height: 100%;
	}
	.lead-stack .num,
	.lead-stack :global(.hover-play) {
		grid-area: 1 / 1;
		transition: opacity 0.1s ease;
	}
	.lead-stack :global(.hover-play) {
		opacity: 0;
		color: var(--text);
	}

	@media (hover: hover) {
		.row:hover {
			background: var(--hover) !important;
		}
		.row:hover .lead-stack .num {
			opacity: 0;
		}
		.row:hover .lead-stack :global(.hover-play) {
			opacity: 1;
		}
		.row:hover .more {
			opacity: 1;
		}
	}

	.lead {
		display: grid;
		place-items: center;
		width: 100%;
		height: 100%;
		color: var(--text-2);
		font-size: 14px;
		font-variant-numeric: tabular-nums;
	}
	.thumb {
		position: relative;
		width: 40px;
		--art-radius: 4px;
	}
	.thumb-overlay {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		border-radius: 4px;
		background: rgba(0, 0, 0, 0.45);
		--bar: #fff;
	}
	.main {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		justify-content: center;
		min-width: 0;
		height: 100%;
		text-align: left;
		gap: 1px;
	}
	.title {
		display: flex;
		align-items: center;
		gap: 5px;
		font-size: 14px;
		color: var(--text);
		max-width: 100%;
	}
	.downloaded {
		width: 20px;
		height: 20px;
		display: grid;
		place-items: center;
		border-radius: 50%;
		color: var(--text-2);
		background: var(--fill-strong);
		flex-shrink: 0;
	}
	.current .title {
		color: var(--accent);
		font-weight: 500;
	}
	.artist,
	.album-col {
		font-size: 13px;
		color: var(--text-2);
		max-width: 100%;
	}
	a.album-col:hover {
		text-decoration: underline;
	}
	.love {
		color: var(--accent);
		display: grid;
		place-items: center;
	}
	.duration {
		font-size: 13px;
		color: var(--text-2);
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.more {
		display: grid;
		place-items: center;
		width: 32px;
		height: 32px;
		border-radius: 50%;
		color: var(--accent);
		opacity: 0;
		transition: opacity 0.12s ease;
	}
	@media (hover: none) {
		.more {
			opacity: 1;
			color: var(--text-2);
		}
	}
	@media (max-width: 699px) {
		.v-list .row {
			grid-template-columns: 44px minmax(0, 1fr) 20px 32px;
		}
		.row {
			grid-template-columns: 30px minmax(0, 1fr) 20px 32px;
		}
		.album-col,
		.duration {
			display: none;
		}
		.v-list.no-album .row {
			grid-template-columns: 44px minmax(0, 1fr) 20px 32px;
		}
	}

	/* Animated "now playing" equalizer */
	.bars {
		display: inline-flex;
		align-items: flex-end;
		gap: 2px;
		height: 12px;
		will-change: transform;
	}
	.bars i {
		width: 3px;
		height: 100%;
		border-radius: 1px;
		background: var(--bar, var(--accent));
		animation: eq 0.9s ease-in-out infinite alternate;
		transform-origin: bottom;
		will-change: transform;
	}
	.bars i:nth-child(2) {
		animation-delay: -0.3s;
	}
	.bars i:nth-child(3) {
		animation-delay: -0.6s;
	}
	.bars.paused i {
		animation-play-state: paused;
	}
	@keyframes eq {
		0% {
			transform: scaleY(0.25);
		}
		100% {
			transform: scaleY(1);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.bars i {
			animation: none;
			transform: scaleY(0.6);
		}
	}
</style>
