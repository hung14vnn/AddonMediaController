<script lang="ts">
	// Desktop transport bar, modelled on music.apple.com: controls left, the "LCD"
	// (art, title, progress) centred, volume + lyrics/queue toggles right.
	import { artistName, time } from '../format';
	import { songMenu } from '../menus';
	import { getPlayer } from '../player.svelte';
	import { href } from '../router.svelte';
	import { artSwap, pop, textSwap } from '../motion';
	import { ui } from '../ui.svelte';
	import Artwork from './Artwork.svelte';
	import Icon from './Icon.svelte';
	import Slider from './Slider.svelte';

	const player = getPlayer();
	const song = $derived(player.current);
	let scrub = $state<number | null>(null);
	const shownTime = $derived(scrub ?? player.currentTime);
</script>

<div class="bar">
	<div class="transport">
		<button class="small" class:on={player.shuffle} aria-label="Shuffle" aria-pressed={player.shuffle} onclick={() => player.toggleShuffle()}>
			<Icon name="shuffle" size={17} />
		</button>
		<button aria-label="Previous" disabled={!song} onclick={() => player.previous()}><Icon name="previous" size={24} /></button>
		<button class="pp" aria-label={player.playing ? 'Pause' : 'Play'} disabled={!song} onclick={() => player.toggle()}>
			{#key player.playing}
				<span class="icon-swap" in:pop={{ from: 0.55, duration: 200 }}><Icon name={player.playing ? 'pause' : 'play'} size={30} /></span>
			{/key}
		</button>
		<button aria-label="Next" disabled={!song} onclick={() => player.next()}><Icon name="next" size={24} /></button>
		<button
			class="small"
			class:on={player.repeat !== 'off'}
			aria-label="Repeat {player.repeat}"
			onclick={() => player.cycleRepeat()}
		>
			<Icon name={player.repeat === 'one' ? 'repeatOne' : 'repeat'} size={17} />
		</button>
	</div>

	<div class="lcd" class:empty={!song}>
		{#if song}
			<button class="lcd-art" aria-label="Open Now Playing" onclick={() => (ui.nowPlaying = true)}>
				{#key song.id}
					<div in:artSwap={{ duration: 360 }}><Artwork id={song.coverArt} size={64} seed={song.album ?? song.title} /></div>
				{/key}
			</button>
			<div class="lcd-body">
				{#key song.id}
				<div class="lcd-text" in:textSwap={{ dx: 0, duration: 400 }}>
					<span class="lcd-title ellipsis">{song.title}</span>
					<span class="lcd-sub ellipsis">
						{#if song.artistId}<a href={href.artist(song.artistId)}>{artistName(song)}</a>{:else}{artistName(song)}{/if}
						{#if song.album}
							&nbsp;—&nbsp;{#if song.albumId}<a href={href.album(song.albumId)}>{song.album}</a>{:else}{song.album}{/if}
						{/if}
					</span>
					<button class="lcd-more" aria-label="More options" onclick={(e) => ui.openMenu(e, songMenu(song))}>
						<Icon name="more" size={18} />
					</button>
				</div>
				{/key}
				<div class="lcd-progress">
					<span class="t">{time(shownTime)}</span>
					<Slider
						value={player.currentTime}
						max={player.duration}
						label="Seek"
						onchange={(v) => player.seek(v)}
						oninput={(v) => (scrub = v)}
					/>
					<span class="t">-{time(Math.max(0, player.duration - shownTime))}</span>
				</div>
			</div>
		{:else}
			<Icon name="note" size={28} />
		{/if}
	</div>

	<div class="right">
		<div class="volume">
			<button aria-label={player.muted ? 'Unmute' : 'Mute'} onclick={() => player.toggleMute()}>
				<Icon name={player.muted || player.volume === 0 ? 'speakerLow' : 'speaker'} size={18} />
			</button>
			<Slider value={player.muted ? 0 : player.volume} max={1} step={0.01} label="Volume" onchange={(v) => player.setVolume(v)} oninput={(v) => v !== null && player.setVolume(v)} />
		</div>
		<button class="small" class:on={ui.nowPlaying && ui.panel === 'lyrics'} aria-label="Lyrics" disabled={!song} onclick={() => ui.togglePanel('lyrics')}>
			<Icon name="lyrics" size={19} />
		</button>
		<button class="small" class:on={ui.nowPlaying && ui.panel === 'queue'} aria-label="Playing Next" onclick={() => ui.togglePanel('queue')}>
			<Icon name="queue" size={19} />
		</button>
	</div>
</div>

<style>
	.bar {
		height: var(--bar-h);
		display: grid;
		grid-template-columns: minmax(200px, 1fr) minmax(320px, 660px) minmax(200px, 1fr);
		align-items: center;
		gap: 16px;
		padding: 0 20px;
		background: var(--chrome);
		backdrop-filter: saturate(1.8) blur(24px);
		-webkit-backdrop-filter: saturate(1.8) blur(24px);
		border-bottom: 0.5px solid var(--hairline);
	}
	button {
		display: grid;
		place-items: center;
		color: var(--text);
		border-radius: 6px;
	}
	button:disabled {
		color: var(--text-3);
	}
	.transport {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 18px;
	}
	.small {
		color: var(--text-2);
		width: 28px;
		height: 28px;
	}
	.small.on {
		color: var(--accent);
	}
	.pp {
		width: 40px;
		height: 40px;
	}
	.lcd {
		display: flex;
		align-items: stretch;
		height: 50px;
		border-radius: 7px;
		background: var(--lcd);
		box-shadow: inset 0 0 0 0.5px var(--hairline);
		overflow: hidden;
		min-width: 0;
	}
	.lcd.empty {
		align-items: center;
		justify-content: center;
		color: var(--text-3);
	}
	.lcd-art {
		width: 50px;
		overflow: hidden;
		flex-shrink: 0;
		--art-radius: 0;
		border-radius: 0;
	}
	/* The swap-animation wrapper has no intrinsic width inside the grid button;
	   without this it collapses to 0 and the artwork disappears. */
	.lcd-art > div {
		width: 100%;
	}
	.lcd-body {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		justify-content: flex-end;
		padding: 0 10px;
	}
	.lcd-text {
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
		position: relative;
		padding: 0 26px;
		line-height: 1.25;
	}
	.lcd-title {
		font-size: 13px;
		font-weight: 500;
		max-width: 100%;
	}
	.lcd-sub {
		font-size: 12px;
		color: var(--text-2);
		max-width: 100%;
	}
	.lcd-sub a:hover {
		text-decoration: underline;
	}
	.lcd-more {
		position: absolute;
		right: 0;
		top: 50%;
		transform: translateY(-50%);
		color: var(--text-2);
		opacity: 0;
	}
	.lcd:hover .lcd-more,
	.lcd-more:focus-visible {
		opacity: 1;
	}
	.lcd-progress {
		display: flex;
		align-items: center;
		gap: 6px;
		height: 14px;
		--slider-fill: var(--text-2);
	}
	.lcd-progress .t {
		font-size: 10px;
		color: var(--text-2);
		font-variant-numeric: tabular-nums;
		width: 36px;
		opacity: 0;
		transition: opacity 0.15s;
	}
	.lcd-progress .t:last-child {
		text-align: right;
	}
	.lcd:hover .t {
		opacity: 1;
	}
	.right {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 10px;
	}
	.volume {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 130px;
		color: var(--text-2);
	}
	.volume button {
		color: var(--text-2);
	}
</style>
