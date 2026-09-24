<script lang="ts">
	// Context menu, "Add to Playlist" sheet and toast; one instance at the app root.
	import { dialog, fadeOnly, pop, toast } from '../motion';
	import { ui } from '../ui.svelte';
	import Artwork from './Artwork.svelte';
	import Icon from './Icon.svelte';

	let menuEl = $state<HTMLDivElement | null>(null);
	let pos = $state({ x: 0, y: 0 });
	let newName = $state('');

	// TỐI ƯU 1: Tính toán lại vị trí Menu an toàn khi DOM đã render
	$effect(() => {
		const m = ui.menu;
		if (!m || !menuEl) return;

		const { offsetWidth: w, offsetHeight: h } = menuEl;
		pos = {
			x: Math.max(8, Math.min(m.x, window.innerWidth - w - 8)),
			y: m.y + h > window.innerHeight - 8 ? Math.max(8, m.y - h) : m.y
		};

		menuEl.querySelector<HTMLButtonElement>('button')?.focus();
	});

	$effect(() => {
		if (ui.playlistPicker) {
			ui.refreshPlaylists();
			newName = '';
		}
	});

	function onKey(e: KeyboardEvent) {
		if (e.key !== 'Escape') return;
		if (ui.menu) ui.menu = null;
		else if (ui.playlistPicker) ui.playlistPicker = null;
	}
</script>

<svelte:window onkeydown={onKey} onresize={() => (ui.menu = null)} />

{#if ui.menu}
	<div
		class="scrim"
		role="presentation"
		onclick={() => (ui.menu = null)}
		oncontextmenu={(e) => {
			e.preventDefault();
			ui.menu = null;
		}}
	></div>
	<div
		class="menu"
		role="menu"
		in:pop
		out:fadeOnly={{ duration: 120 }}
		bind:this={menuEl}
		style:left="{pos.x}px"
		style:top="{pos.y}px"
	>
		{#each ui.menu.items as item}
			<button
				role="menuitem"
				class:danger={item.danger}
				onclick={() => {
					ui.menu = null;
					item.action();
				}}
			>
				<span>{item.label}</span>
				{#if item.icon}<Icon name={item.icon} size={17} />{/if}
			</button>
		{/each}
	</div>
{/if}

{#if ui.playlistPicker}
	{@const songs = ui.playlistPicker}
	<div
		class="sheet-scrim"
		role="presentation"
		transition:fadeOnly
		onclick={() => (ui.playlistPicker = null)}
	></div>
	<div
		class="sheet"
		role="dialog"
		in:dialog
		out:fadeOnly={{ duration: 150 }}
		aria-modal="true"
		aria-label="Add to Playlist"
	>
		<header>
			<h3>Add to Playlist</h3>
			<button class="x" aria-label="Close" onclick={() => (ui.playlistPicker = null)}>
				<Icon name="close" size={18} />
			</button>
		</header>
		<form
			class="new"
			onsubmit={(e) => {
				e.preventDefault();
				if (!newName.trim()) return;
				ui.createPlaylistWith(newName.trim(), songs);
				ui.playlistPicker = null;
			}}
		>
			<span class="plus"><Icon name="plus" size={22} /></span>
			<input placeholder="New Playlist…" bind:value={newName} />
			{#if newName.trim()}<button class="create" type="submit">Create</button>{/if}
		</form>
		<ul>
			{#each ui.playlists as pl (pl.id)}
				<li>
					<button
						onclick={() => {
							ui.addSongsToPlaylist(pl, songs);
							ui.playlistPicker = null;
						}}
					>
						<span class="art"><Artwork id={pl.coverArt} size={64} seed={pl.name} icon="playlist" /></span>
						<span class="text">
							<span class="ellipsis">{pl.name}</span>
							<small>{pl.songCount ?? 0} songs</small>
						</span>
					</button>
				</li>
			{/each}
		</ul>
	</div>
{/if}

{#if ui.toast}
	<div class="toast" role="status" in:toast out:fadeOnly>{ui.toast}</div>
{/if}

<style>
	.scrim,
	.sheet-scrim {
		position: fixed;
		inset: 0;
		z-index: 90;
	}
	.sheet-scrim {
		background: rgba(0, 0, 0, 0.4);
	}
	.menu {
		position: fixed;
		z-index: 91;
		min-width: 220px;
		padding: 5px;
		border-radius: 12px;

		background: var(--menu, rgba(32, 32, 35, 0.88));
		backdrop-filter: saturate(1.8) blur(14px);
		-webkit-backdrop-filter: saturate(1.8) blur(14px);

		box-shadow:
			0 12px 40px rgba(0, 0, 0, 0.28),
			0 0 0 0.5px var(--hairline);
		transform-origin: top left;
		will-change: transform, opacity;
	}
	.menu button {
		animation: item-in 0.2s ease both;
		width: 100%;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 20px;
		height: 32px;
		padding: 0 10px;
		border-radius: 7px;
		font-size: 14px;
		color: var(--text);
		text-align: left;
		transition: background 0.12s ease, color 0.12s ease;
	}
	.menu button :global(svg) {
		color: var(--text-2);
		transition: color 0.12s ease;
	}
	.menu button:hover,
	.menu button:focus-visible {
		background: var(--accent);
		color: #fff;
		outline: none;
	}
	.menu button:hover :global(svg),
	.menu button:focus-visible :global(svg) {
		color: #fff;
	}
	.menu button:nth-child(2) {
		animation-delay: 15ms;
	}
	.menu button:nth-child(3) {
		animation-delay: 30ms;
	}
	.menu button:nth-child(4) {
		animation-delay: 45ms;
	}
	.menu button:nth-child(n + 5) {
		animation-delay: 60ms;
	}

	@keyframes item-in {
		from {
			opacity: 0;
			transform: translateY(-3px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	.menu .danger {
		color: #ff3b30;
	}
	.sheet {
		position: fixed;
		z-index: 91;
		left: 50%;
		top: 50%;
		transform: translate(-50%, -50%);
		width: min(420px, calc(100vw - 32px));
		max-height: min(560px, 80vh);
		display: flex;
		flex-direction: column;
		border-radius: 16px;
		background: var(--bg-elevated);
		box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35);
		overflow: hidden;
		will-change: transform, opacity;
	}
	.sheet header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 16px 16px 8px;
	}
	.sheet h3 {
		margin: 0;
		font-size: 17px;
	}
	.x {
		width: 30px;
		height: 30px;
		border-radius: 50%;
		display: grid;
		place-items: center;
		background: var(--fill);
		color: var(--text-2);
	}
	.new {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 8px 16px;
	}
	.plus {
		width: 48px;
		height: 48px;
		border-radius: 6px;
		display: grid;
		place-items: center;
		color: var(--accent);
		background: var(--fill);
		flex-shrink: 0;
	}
	.new input {
		flex: 1;
		min-width: 0;
		border: 0;
		background: none;
		font: inherit;
		font-size: 15px;
		color: var(--text);
		outline: none;
	}
	.create {
		color: var(--accent);
		font-weight: 600;
	}
	.sheet ul {
		list-style: none;
		margin: 0;
		padding: 0 8px 12px;
		overflow-y: auto;
	}
	.sheet li button {
		width: 100%;
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 6px 8px;
		border-radius: 8px;
		text-align: left;
		color: var(--text);
		transition: background 0.12s ease;
	}
	.sheet li button:hover {
		background: var(--hover);
	}
	.art {
		width: 48px;
		--art-radius: 6px;
	}
	.text {
		display: flex;
		flex-direction: column;
		min-width: 0;
		font-size: 15px;
	}
	.text small {
		color: var(--text-2);
		font-size: 12px;
	}

	.toast {
		position: fixed;
		z-index: 95;
		left: 50%;
		bottom: calc(var(--toast-offset, 24px) + env(safe-area-inset-bottom));
		transform: translateX(-50%);
		padding: 10px 18px;
		border-radius: 999px;
		font-size: 14px;
		font-weight: 500;
		color: var(--text);
		background: var(--menu, rgba(32, 32, 35, 0.9));
		box-shadow: 0 8px 30px rgba(0, 0, 0, 0.25);
		white-space: nowrap;
		will-change: transform, opacity;
	}
</style>