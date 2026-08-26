<script lang="ts">
	import { page } from '$app/state';
	import { AUTH_FREE_PATHS } from '$lib/constants';
	import { authStore } from '$lib/stores/authStore.svelte';
	import { logout } from '$lib/utils/logout';
	import { migratePageSourceKeys } from '$lib/stores/musicSource';
	import { errorModal } from '$lib/stores/errorModal';
	import { libraryStore } from '$lib/stores/library';
	import { integrationStore } from '$lib/stores/integration';
	import { downloadsActivity } from '$lib/stores/downloadsActivity.svelte';
	import { initCacheTTLs } from '$lib/stores/cacheTtl';
	import { playerStore } from '$lib/stores/player.svelte';
	import { launchYouTubePlayback } from '$lib/player/launchYouTubePlayback';
	import { playbackToast } from '$lib/stores/playbackToast.svelte';
	import { scrobbleManager } from '$lib/stores/scrobble.svelte';
	import { imageSettingsStore } from '$lib/stores/imageSettings';
	import { serviceStatusStore } from '$lib/stores/serviceStatus';
	import { resumeAudioEngine, setAudioElement } from '$lib/player/audioElement';
	import { eqStore } from '$lib/stores/eq.svelte';
	import Player from '$lib/components/Player.svelte';
	import PreviewWidget from '$lib/components/discover/PreviewWidget.svelte';
	import CacheSyncIndicator from '$lib/components/CacheSyncIndicator.svelte';
	import AddToPlaylistModal, {
		registerPlaylistModal,
		unregisterPlaylistModal
	} from '$lib/components/AddToPlaylistModal.svelte';
	import DiscographyDownloadModal from '$lib/components/DiscographyDownloadModal.svelte';
	import BatchDownloadIndicator from '$lib/components/BatchDownloadIndicator.svelte';
	import { syncStatus } from '$lib/stores/syncStatus.svelte';
	import SidebarServices from '$lib/components/SidebarServices.svelte';
	import DegradedBanner from '$lib/components/DegradedBanner.svelte';
	import ServiceHealthIndicator from '$lib/components/ServiceHealthIndicator.svelte';
	import VersionOverlays from '$lib/components/VersionOverlays.svelte';
	import SearchSuggestions from '$lib/components/SearchSuggestions.svelte';
	import type { SuggestResult } from '$lib/types';
	import { onMount, onDestroy, untrack } from 'svelte';
	import { cancelPendingImages } from '$lib/utils/lazyImage';
	import { abortAllPageRequests } from '$lib/utils/navigationAbort';
	import { pendingApprovalCountStore } from '$lib/stores/pendingApprovalCountStore.svelte';
	import { nowPlayingStore } from '$lib/stores/nowPlayingSessions.svelte';
	import { nowPlayingReporter } from '$lib/stores/nowPlayingReporter.svelte';
	import { createNavigationProgressController } from '$lib/utils/navigationProgress';
	import { fromStore } from 'svelte/store';
	import {
		Settings,
		Search,
		House,
		Compass,
		Menu,
		Download,
		PanelLeft,
		TriangleAlert,
		Info,
		X,
		UserRound,
		Inbox,
		ListMusic,
		ArrowUpCircle,
		LogOut,
		ShieldCheck,
		Heart
	} from 'lucide-svelte';
	import type { Snippet } from 'svelte';
	import QueryProvider from '$lib/queries/QueryProvider.svelte';
	import type { Component, Snippet } from 'svelte';

	let { children }: { children: Snippet } = $props();

	type ShellComponent = Component<{ children: Snippet }>;
	let AppShell = $state<ShellComponent | null>(null);
	let shellLoadFailed = $state(false);
	let shellLoadAttempt = $state(0);
	const needsAppShell = $derived(
		!AUTH_FREE_PATHS.some((path) => page.url.pathname.startsWith(path))
	);

	$effect(() => {
		if (!needsAppShell || AppShell) return;
		const requestedAttempt = shellLoadAttempt;
		let cancelled = false;
		shellLoadFailed = false;
		void loadAuthenticatedAppShell()
			.then((component) => {
				if (!cancelled && requestedAttempt === shellLoadAttempt) AppShell = component;
			})
			.catch(() => {
				if (!cancelled && requestedAttempt === shellLoadAttempt) shellLoadFailed = true;
			});
		return () => {
			cancelled = true;
		};
	});

	function retryShellLoad(): void {
		shellLoadAttempt += 1;
	}
</script>

<QueryProvider>
	<div data-testid="app-shell" data-theme="dark" class="droppedneedle-app-shell">
		{#if showNavigationProgress}
			<div class="fixed top-0 left-0 right-0 z-120 pointer-events-none">
				<progress class="progress progress-primary w-full h-1"></progress>
			</div>
		{/if}

		{#if showAppShell}
			<DegradedBanner />
			<VersionOverlays bind:updateAvailable={versionUpdateAvailable} />

			<div class="drawer md:drawer-open">
				<input id="main-drawer" type="checkbox" class="drawer-toggle" />

				<div class="drawer-content flex min-w-0 flex-col isolate">
					<div
						class="droppedneedle-topbar navbar bg-base-100/95 backdrop-blur shadow-sm sticky top-0 z-50"
					>
						<div class="navbar-start w-auto">
							<a
								href="/"
								class="btn btn-ghost px-2 font-display text-base font-bold max-xs:hidden sm:px-4 sm:text-lg"
								aria-label="Addon Music home"
							>
								<span
									><span class="text-primary">Addon</span><span class="text-base-content">ify</span
									></span
								>
							</a>
						</div>
						<div class="navbar-center min-w-0 grow justify-center px-1 sm:px-4">
							<div class="w-full max-w-2xl">
								<SearchSuggestions
									bind:query
									onSearch={handleSearch}
									onSelect={handleSuggestionSelect}
									id="navbar-suggest"
								/>
							</div>
						</div>
						<div class="navbar-end w-auto pr-1 sm:pr-2">
							<ServiceHealthIndicator />
							<a href="/profile" class="btn btn-ghost btn-circle btn-md" aria-label="Profile">
								{#if authStore.user?.avatar_url}
									<img
										src={authStore.user.avatar_url}
										alt="Profile"
										class="h-7 w-7 rounded-full object-cover"
									/>
								{:else}
									<UserRound class="h-6 w-6" />
								{/if}
							</a>
						</div>
						<button class="btn btn-sm" type="button" onclick={retryShellLoad}>Try again</button>
					</div>

					<LibraryActivityStrip />

					<div
						class="droppedneedle-main-content flex-1"
						class:droppedneedle-player-visible={playerStore.isPlayerVisible &&
							currentPath !== '/library/local'}
					>
						{@render children()}
					</div>
				</div>
			{/if}
		{:else}
			{@render children()}
		{/if}
	</div>
</QueryProvider>
