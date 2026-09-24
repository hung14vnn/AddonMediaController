<script lang="ts">
	import { router } from '../router.svelte';
	import Icon from './Icon.svelte';

	const tabs = [
		{ path: '/', label: 'Home', icon: 'home', match: ['home'] },
		{ path: '/browse', label: 'Browse', icon: 'browse', match: ['browse', 'genres', 'genre'] },
		{
			path: '/library',
			label: 'Library',
			icon: 'library',
			match: ['library', 'profile', 'recent', 'artists', 'albums', 'songs', 'playlists', 'loved', 'playlist']
		},
		{ path: '/search', label: 'Search', icon: 'search', match: ['search'] }
	];

	// Album/artist detail pages stay in whichever tab the user came from.
	let lastTab = $state('/');
	const active = $derived.by(() => {
		const hit = tabs.find((t) => t.match.includes(router.route.name));
		return hit?.path ?? lastTab;
	});
	$effect(() => {
		lastTab = active;
	});
</script>

<nav class="tabbar" aria-label="Tabs">
	{#each tabs as tab}
		<a href="#{tab.path}" class:active={active === tab.path} aria-current={active === tab.path ? 'page' : undefined}>
			<Icon name={tab.icon} size={24} />
			<span>{tab.label}</span>
		</a>
	{/each}
</nav>

<style>
	.tabbar {
		display: flex;
		justify-content: space-around;
		padding: 4px 8px max(6px, env(safe-area-inset-bottom));
		background: var(--tabbar);
		backdrop-filter: saturate(1.8) blur(24px);
		-webkit-backdrop-filter: saturate(1.8) blur(24px);
		border-top: 0.5px solid var(--hairline);
	}
	a {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
		padding-top: 4px;
		font-size: 10px;
		font-weight: 500;
		color: var(--text-3);
	}
	a {
		transition: color 0.2s ease;
	}
	a.active {
		color: var(--accent);
	}
	a.active :global(svg) {
		animation: tab-bounce 0.42s cubic-bezier(0.3, 1.6, 0.5, 1);
	}
	@keyframes tab-bounce {
		0% {
			transform: scale(0.8);
		}
		100% {
			transform: scale(1);
		}
	}
</style>
