<script lang="ts">
	// Floating mini player above the tab bar (iOS 26-style pill).
	import { getPlayer } from '../player.svelte';
	import { artSwap, pop, rise, textSwap } from '../motion';
	import { ui } from '../ui.svelte';
	import Artwork from './Artwork.svelte';
	import Icon from './Icon.svelte';

	const player = getPlayer();
	const song = $derived(player.current);

	// TỐI ƯU 1: Làm tròn % về 1 chữ số thập phân (ví dụ: "45.2%")
	// Giúp giảm Style Recalculation của trình duyệt
	const pct = $derived.by(() => {
		if (!player.duration || player.duration <= 0) return '0';
		const raw = (player.currentTime / player.duration) * 100;
		return Math.min(100, Math.max(0, raw)).toFixed(1);
	});
</script>

{#if song}
	<div class="mini" style:--pct="{pct}%" in:rise out:rise={{ duration: 220 }}>
		<button class="open" onclick={() => (ui.nowPlaying = true)} aria-label="Open Now Playing">
			{#key song.id}
				<span class="art" in:artSwap={{ duration: 320 }}>
					<Artwork id={song.coverArt} size={64} seed={song.album ?? song.title} />
				</span>
				<span class="title ellipsis" in:textSwap>{song.title}</span>
			{/key}
		</button>
		<button class="ctl" aria-label={player.playing ? 'Pause' : 'Play'} onclick={() => player.toggle()}>
			{#key player.playing}
				<span class="icon-swap" in:pop={{ from: 0.5, duration: 200 }}>
					<Icon name={player.playing ? 'pause' : 'play'} size={24} />
				</span>
			{/key}
		</button>
		<button class="ctl" aria-label="Next" onclick={() => player.next()}>
			<Icon name="next" size={24} />
		</button>
		<span class="progress" aria-hidden="true"></span>
	</div>
{/if}

<style>
	.mini {
		position: relative;
		display: flex;
		align-items: center;
		gap: 4px;
		height: 56px;
		margin: 0 10px 8px;
		padding: 0 8px 0 6px;
		border-radius: 16px;
		background: var(--chrome-strong, rgba(30, 30, 30, 0.95));
		backdrop-filter: none;
		-webkit-backdrop-filter: none;

		box-shadow:
			0 6px 24px rgb(0 0 0 / 0.16),
			inset 0 0 0 0.5px var(--hairline);
		overflow: hidden;
	}

	@media (min-width: 769px) {
		.mini {
			backdrop-filter: saturate(1.8) blur(15px);
			-webkit-backdrop-filter: saturate(1.8) blur(15px);
		}
	}

	.open {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 12px;
		height: 100%;
		text-align: left;
	}
	.art {
		width: 44px;
		--art-radius: 7px;
		--art-shadow: 0 2px 8px rgb(0 0 0 / 0.18);
	}
	.title {
		font-size: 15px;
		font-weight: 500;
	}
	.ctl {
		width: 44px;
		height: 44px;
		display: grid;
		place-items: center;
		color: var(--text);
	}

	.progress {
		position: absolute;
		left: 0;
		bottom: 0;
		height: 2px;
		width: 100%;

		/* TỐI ƯU 3: Dùng transform: scaleX thay vì width để không gây Reflow Layout */
		transform: scaleX(calc(var(--pct) / 100));
		transform-origin: left center;
		transition: transform 0.3s linear;
		will-change: transform;

		background: var(--accent);
		opacity: 0.8;
	}
</style>