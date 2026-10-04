<script lang="ts">
	import { tick } from 'svelte';
	import { router } from '../router.svelte';
	import { search } from '../search.svelte';
	import Icon from './Icon.svelte';

	const tabs = [
		{ path: '/', label: 'Home', icon: 'home', match: ['home'] },
		{ path: '/browse', label: 'Browse', icon: 'browse', match: ['browse', 'genres', 'genre'] },
		{
			path: '/library',
			label: 'Library',
			icon: 'library',
			match: ['library', 'profile', 'recent', 'artists', 'albums', 'songs', 'playlists', 'loved', 'playlist']
		}
	];

	const BTN = 48;

	let lastTab = $state('/');
	let { compactDock = $bindable(false), onexpand }: { compactDock?: boolean; onexpand?: () => void } = $props();
	let input: HTMLInputElement | undefined = $state();
	let pw = $state(0);

	const searching = $derived(router.route.name === 'search');
	const collapsed = $derived(searching || compactDock);

	$effect(() => {
		const currentRoute = router.route.name;
		const hit = tabs.find((t) => t.match.includes(currentRoute));
		if (hit) {
			lastTab = hit.path;
		}
	});

	const active = $derived(
		tabs.find((t) => t.match.includes(router.route.name))?.path ?? lastTab
	);
	const activeIndex = $derived(Math.max(0, tabs.findIndex((t) => t.path === active)));

	const iconShift = $derived.by(() => {
		if (!pw) return 0;
		const n = tabs.length;
		const tw = (pw - 12 - (n - 1) * 4) / n;
		const center = 6 + activeIndex * (tw + 4) + tw / 2;
		return BTN / 2 - center;
	});

	function goSearchRoute(value = search.q, replace = false) {
		const target = value ? `/search?q=${encodeURIComponent(value)}` : '/search';
		if (router.route.name !== 'search' || (router.route.name === 'search' && (router.route.query ?? '') !== value)) {
			router.go(target, replace);
		}
	}

	async function openSearch(event: MouseEvent) {
		event.preventDefault();
		if (router.route.name !== 'search') {
			await router.go(search.q ? `/search?q=${encodeURIComponent(search.q)}` : '/search');
		}
		await tick();
		input?.focus();
	}

	function handleInput(event: Event) {
		search.q = (event.currentTarget as HTMLInputElement).value;
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			input?.blur();
			if (search.q) goSearchRoute(search.q, true);
		}
	}

	function clear() {
		search.q = '';
		if (router.route.name === 'search') goSearchRoute('', true);
		input?.focus();
	}
</script>

<nav class="tabbar" class:collapsed class:searching aria-label="Tabs">
	<div class="pill" bind:clientWidth={pw}>
		<span class="bg" aria-hidden="true"></span>
		<div class="tabs" style:--i={activeIndex} style:--n={tabs.length}>
			<span class="indicator" aria-hidden="true"></span>
			{#each tabs as tab}
				{@const isActive = active === tab.path}
				<a
					href="#{tab.path}"
					class:active={isActive}
					aria-current={isActive ? 'page' : undefined}
					inert={collapsed && !isActive}
					style:--dx="{iconShift}px"
					onclick={() => isActive && onexpand?.()}
				>
					<Icon name={tab.icon} size={24} />
					<span class="label">{tab.label}</span>
				</a>
			{/each}
		</div>
	</div>

	<a class="search-btn" href="#/search" aria-label="Search" inert={searching} onclick={openSearch}>
		<Icon name="search" size={22} />
	</a>

	<div class="field" role="search">
		<span class="f-icon" aria-hidden="true">
			<Icon name="search" size={22} />
		</span>

		<input
			bind:this={input}
			bind:value={search.q}
			type="search"
			placeholder="Artists, songs, albums..."
			enterkeyhint="search"
			autocomplete="off"
			autocapitalize="off"
			spellcheck="false"
			tabindex={searching ? 0 : -1}
			aria-hidden={!searching}
			oninput={handleInput}
			onkeydown={onKeydown}
		/>

		<button class="f-end" aria-label={search.q ? 'Clear' : 'Voice search'} inert={!searching} onclick={search.q ? clear : undefined}>
			{#if search.q}
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<circle cx="12" cy="12" r="9" /><path d="M9 9l6 6M15 9l-6 6" />
				</svg>
			{:else}
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
				</svg>
			{/if}
		</button>
	</div>
</nav>

<style>
	.tabbar {
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		height: calc(var(--pad, 6px) + var(--tab-h, 58px));
		z-index: 3;
		pointer-events: none !important;
	}
	.tabbar > * {
		pointer-events: auto;
	}

	.pill {
		position: absolute;
		left: var(--side, 12px);
		bottom: var(--pad, 6px);
		width: calc(100% - 2 * var(--side, 12px) - var(--tab-h, 58px) - var(--gap, 8px));
		height: var(--tab-h, 58px);
		pointer-events: none;
	}
	.pill a {
		pointer-events: auto;
	}

	.bg {
		position: absolute;
		left: 0;
		top: 0;
		width: 100%;
		height: 100%;
		box-sizing: border-box;
		border: 0.5px solid var(--hairline);
		border-radius: 999px;
		background: var(--tabbar);
		box-shadow:
			0 6px 24px rgb(0 0 0 / 0.16),
			inset 0 0 0 0.5px rgb(255 255 255 / 0.04);
		contain: layout paint;
		transition:
			width var(--dur, 0.5s) var(--ease, ease),
			height var(--dur, 0.5s) var(--ease, ease),
			top var(--dur, 0.5s) var(--ease, ease);
	}
	.tabbar.collapsed .bg {
		width: var(--btn, 48px);
		height: var(--btn, 48px);
		top: calc((var(--tab-h, 58px) - var(--btn, 48px)) / 2);
	}

	.tabs {
		position: absolute;
		inset: 0;
		box-sizing: border-box;
		display: flex;
		justify-content: space-around;
		align-items: stretch;
		gap: 4px;
		padding: 5px 6px;
	}

	.indicator {
		position: absolute;
		top: 5px;
		bottom: 5px;
		left: 6px;
		width: calc((100% - 12px - (var(--n) - 1) * 4px) / var(--n));
		border-radius: 22px;
		background: var(--fill);
		pointer-events: none;
		transform: translateX(calc(var(--i) * (100% + 4px)));
		transition:
			transform 0.45s var(--ease, cubic-bezier(0.32, 0.72, 0, 1)),
			opacity calc(var(--dur, 0.5s) * 0.5) var(--ease, ease);
		will-change: transform;
	}
	.tabbar.collapsed .indicator {
		opacity: 0;
	}

	.tabs a {
		position: relative;
		z-index: 1;
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 2px;
		min-width: 0;
		padding: 5px 2px 2px;
		border-radius: 22px;
		font-size: 10px;
		font-weight: 500;
		color: var(--text-3);
		transition:
			transform var(--dur, 0.5s) var(--ease, ease),
			opacity calc(var(--dur, 0.5s) * 0.5) var(--ease, ease),
			color 0.25s ease;
	}
	.tabs a.active {
		color: var(--accent);
	}
	.tabs a.active :global(svg) {
		animation: tab-bounce 0.42s cubic-bezier(0.3, 1.6, 0.5, 1);
	}

	.tabbar.collapsed .tabs a:not(.active) {
		opacity: 0;
	}
	.tabbar.collapsed .tabs a.active {
		transform: translate(var(--dx, 0px), 7px);
		color: var(--text);
	}
	.label {
		transition: opacity calc(var(--dur, 0.5s) * 0.35) var(--ease, ease);
	}
	.tabbar.collapsed .label {
		opacity: 0;
	}

	.search-btn {
		position: absolute;
		right: var(--side, 12px);
		bottom: var(--pad, 6px);
		width: var(--tab-h, 58px);
		height: var(--tab-h, 58px);
		display: grid;
		place-items: center;
		border-radius: 50%;
		border: 0.5px solid var(--hairline);
		box-sizing: border-box;
		background: var(--tabbar);
		box-shadow:
			0 6px 24px rgb(0 0 0 / 0.16),
			inset 0 0 0 0.5px rgb(255 255 255 / 0.04);
		color: var(--text);
		transform-origin: right center;
		will-change: transform, opacity;
		transition:
			transform var(--dur, 0.5s) var(--ease, ease),
			opacity calc(var(--dur, 0.5s) * 0.4) var(--ease, ease);
	}
	.tabbar.collapsed .search-btn {
		transform: scale(0.83);
	}
	.tabbar.searching .search-btn {
		opacity: 0;
		pointer-events: none;
	}

	.field {
		position: absolute;
		right: var(--side, 12px);
		bottom: var(--row-b, 13px);
		width: calc(100% - 2 * var(--side, 12px) - var(--btn, 48px) - var(--gap, 8px));
		height: var(--btn, 48px);
		box-sizing: border-box;
		overflow: hidden;
		border-radius: calc(var(--btn, 48px) / 2);
		border: 0.5px solid var(--hairline);
		background: var(--tabbar);
		box-shadow:
			0 6px 24px rgb(0 0 0 / 0.16),
			inset 0 0 0 0.5px rgb(255 255 255 / 0.04);
		transform-origin: right center;
		transform: scaleX(0.2);
		opacity: 0;
		pointer-events: none;
		will-change: transform, opacity;
		transition:
			transform var(--dur, 0.5s) var(--ease, ease),
			opacity calc(var(--dur, 0.5s) * 0.4) var(--ease, ease);
	}
	.tabbar.searching .field {
		transform: none;
		opacity: 1;
		pointer-events: auto;
	}

	.field > * {
		opacity: 0;
		transition: opacity calc(var(--dur, 0.5s) * 0.3) ease;
	}
	.tabbar.searching .field > * {
		opacity: 1;
		transition-duration: calc(var(--dur, 0.5s) * 0.4);
		transition-delay: calc(var(--dur, 0.5s) * 0.3);
	}

	.f-icon {
		position: absolute;
		left: 0;
		top: 0;
		bottom: 0;
		width: 44px;
		display: grid;
		place-items: center;
		color: var(--text-2);
	}

	input {
		position: absolute;
		left: 44px;
		right: 44px;
		top: 0;
		bottom: 0;
		min-width: 0;
		padding: 0;
		border: 0;
		outline: none;
		background: transparent;
		color: var(--text);
		font: inherit;
		font-size: 16px;
	}
	input::-webkit-search-cancel-button,
	input::-webkit-search-decoration {
		-webkit-appearance: none;
		display: none;
	}
	input::placeholder {
		color: var(--text-3);
	}

	.f-end {
		position: absolute;
		right: 0;
		top: 0;
		bottom: 0;
		width: 44px;
		display: grid;
		place-items: center;
		padding: 0;
		border: 0;
		background: none;
		color: var(--text-2);
	}

	@keyframes tab-bounce {
		0% {
			transform: scale(0.8);
		}
		100% {
			transform: scale(1);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.bg,
		.indicator,
		.tabs a,
		.label,
		.search-btn,
		.field,
		.field > * {
			transition-duration: 0.01ms;
			transition-delay: 0s;
		}
	}
</style>