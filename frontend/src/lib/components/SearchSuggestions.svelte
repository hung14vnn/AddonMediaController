<script lang="ts">
	import { getApiUrl } from '$lib/api/api-utils';
	import { Check, Disc3, Download, Search } from 'lucide-svelte';
	import type { SpotifyTrackResult, SuggestResult } from '$lib/types';
	import { API } from '$lib/constants';
	import { isAbortError } from '$lib/utils/errorHandling';
	import { usesMobileLowPowerVisuals } from '$lib/utils/mobilePerformance';
	import { api } from '$lib/api/client';
	import { requestSpotifyTrack } from '$lib/queries/downloads/DownloadMutations.svelte';
	import StreamButton from '$lib/components/discover/StreamButton.svelte';

	interface Props {
		query: string;
		onSearch: () => void;
		onSelect: (result: SuggestResult) => void;
		placeholder?: string;
		inputClass?: string;
		autofocus?: boolean;
		id?: string;
	}

	let {
		query = $bindable(),
		onSearch,
		onSelect,
		placeholder = 'Search...',
		inputClass = '',
		autofocus = false,
		id = 'suggest'
	}: Props = $props();

	const listboxId = $derived(`${id}-listbox`);

	type Suggestion = SuggestResult | SpotifyTrackResult;

	let suggestions = $state<Suggestion[]>([]);
	let imageErrors = $state<Record<string, boolean>>({});
	let loading = $state(false);
	let showDropdown = $state(false);
	let activeIndex = $state(-1);
	let debounceTimeout: ReturnType<typeof setTimeout>;
	let abortController: AbortController | null = null;
	let rootRef: HTMLDivElement;
	let fetchGeneration = 0;
	const download = requestSpotifyTrack();
	let requestedTracks = $state<Set<string>>(new Set());

	const activeDescendant = $derived(
		activeIndex >= 0 && activeIndex < suggestions.length ? `${id}-option-${activeIndex}` : undefined
	);

	function isTrack(result: Suggestion): result is SpotifyTrackResult {
		return result.type === 'track';
	}

	function suggestionKey(result: Suggestion): string {
		return isTrack(result) ? `spotify:${result.spotify_id}` : result.musicbrainz_id;
	}

	function coverUrl(result: SuggestResult): string {
		if (result.cover_url) return result.cover_url;
		return result.type === 'artist'
			? getApiUrl(`/api/v1/covers/artist/${result.musicbrainz_id}?size=250`)
			: getApiUrl(`/api/v1/covers/release-group/${result.musicbrainz_id}?size=250`);
	}

	function handleInput() {
		clearTimeout(debounceTimeout);
		abortController?.abort();
		abortController = null;
		activeIndex = -1;

		if (query.trim().length < 2) {
			suggestions = [];
			showDropdown = false;
			loading = false;
			return;
		}

		// Autocomplete is optional and can trigger a request for every search term.
		// Keep the full search action available on mobile, but do not call /search/suggest.
		if (usesMobileLowPowerVisuals()) {
			suggestions = [];
			showDropdown = false;
			loading = false;
			return;
		}

		loading = true;
		showDropdown = true;

		debounceTimeout = setTimeout(async () => {
			abortController = new AbortController();
			const generation = ++fetchGeneration;

			try {
				const data = await api.get<{
					results?: SuggestResult[];
					tracks?: SpotifyTrackResult[];
				}>(API.search.suggest(query.trim(), 5), {
					signal: abortController.signal
				});
				if (generation !== fetchGeneration) return;
				suggestions = [...(data.results ?? []), ...(data.tracks ?? [])];
				// Clear stale cover-fetch errors: a cold cover now returns 202 (not a decodable
				// placeholder), so onerror fires and would otherwise pin the icon fallback for a
				// result that has since warmed and reappears in a later search.
				imageErrors = {};
				showDropdown = suggestions.length > 0 || loading;
			} catch (e) {
				if (isAbortError(e)) return;
				if (generation !== fetchGeneration) return;
				suggestions = [];
				showDropdown = false;
			} finally {
				if (generation === fetchGeneration) {
					loading = false;
				}
			}
		}, 600);
	}

	function handleFocus() {
		// Reopen suggestions for an existing query without changing its value.
		if (query.trim().length >= 2 && !showDropdown) {
			handleInput();
		}
	}

	// Close the dropdown and cancel any pending lookup. The component lives in the
	// persistent app shell, so its destroy cleanup never runs on navigation: an
	// armed debounce would otherwise fire after we leave and reopen the dropdown
	// over the search page. Bumping the generation retires an in-flight response too.
	function dismiss() {
		clearTimeout(debounceTimeout);
		abortController?.abort();
		abortController = null;
		fetchGeneration++;
		loading = false;
		showDropdown = false;
		suggestions = [];
		activeIndex = -1;
	}

	function handleSubmit(e: SubmitEvent) {
		e.preventDefault();
		dismiss();
		onSearch();
	}

	function handleSelect(result: Suggestion) {
		if (isTrack(result)) return;
		dismiss();
		onSelect(result);
	}

	function requestTrack(track: SpotifyTrackResult, event: MouseEvent) {
		// Keep the search suggestions open while the request is submitted. The
		// button can otherwise move focus away from the search input and trigger
		// the combobox's focusout handler before the click is processed.
		event.preventDefault();
		event.stopPropagation();
		showDropdown = true;
		download.mutate(track.spotify_id, {
			onSuccess: () => (requestedTracks = new Set([...requestedTracks, track.spotify_id]))
		});
	}

	function handleViewAll() {
		dismiss();
		onSearch();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			if (showDropdown) {
				e.preventDefault();
				e.stopPropagation();
				dismiss();
			}
			return;
		}

		if (!showDropdown || suggestions.length === 0) return;

		switch (e.key) {
			case 'ArrowDown':
				e.preventDefault();
				activeIndex = activeIndex < suggestions.length - 1 ? activeIndex + 1 : 0;
				break;
			case 'ArrowUp':
				e.preventDefault();
				activeIndex = activeIndex > 0 ? activeIndex - 1 : suggestions.length - 1;
				break;
			case 'Home':
				if (activeIndex >= 0) {
					e.preventDefault();
					activeIndex = 0;
				}
				break;
			case 'End':
				if (activeIndex >= 0) {
					e.preventDefault();
					activeIndex = suggestions.length - 1;
				}
				break;
			case 'Enter':
				if (activeIndex >= 0 && activeIndex < suggestions.length) {
					e.preventDefault();
					handleSelect(suggestions[activeIndex]);
				}
				break;
		}
	}

	function handleFocusOut(e: FocusEvent) {
		if (rootRef && !rootRef.contains(e.relatedTarget as Node)) {
			showDropdown = false;
		}
	}

	$effect(() => {
		if (!showDropdown) return;
		const handlePointerDown = (e: PointerEvent) => {
			if (rootRef && !rootRef.contains(e.target as Node)) {
				showDropdown = false;
			}
		};
		document.addEventListener('pointerdown', handlePointerDown);
		return () => document.removeEventListener('pointerdown', handlePointerDown);
	});

	$effect(() => {
		return () => {
			clearTimeout(debounceTimeout);
			abortController?.abort();
		};
	});
</script>

<div
	bind:this={rootRef}
	class="relative w-full"
	role="combobox"
	aria-expanded={showDropdown}
	aria-haspopup="listbox"
	aria-controls={listboxId}
	onfocusout={handleFocusOut}
>
	<form onsubmit={handleSubmit}>
		<label class="input input-bordered flex items-center gap-2 w-full {inputClass}">
			<Search class="h-[1em] opacity-50" strokeWidth={2.5} />
			<!-- svelte-ignore a11y_autofocus -->
			<input
				type="search"
				{placeholder}
				bind:value={query}
				oninput={handleInput}
				onfocus={handleFocus}
				onkeydown={handleKeydown}
				class="grow"
				autocomplete="off"
				aria-autocomplete="list"
				aria-controls={listboxId}
				aria-activedescendant={activeDescendant}
				{autofocus}
			/>
			{#if loading}
				<span class="loading loading-spinner loading-sm"></span>
			{/if}
		</label>
	</form>

	{#if showDropdown && (suggestions.length > 0 || loading)}
		<ul
			role="listbox"
			id={listboxId}
			class="suggestion-dropdown absolute top-full left-0 right-0 z-60 mt-1 rounded-box bg-base-200 shadow-xl"
		>
			{#each suggestions as result, i (suggestionKey(result))}
				<li
					role="option"
					id="{id}-option-{i}"
					aria-selected={i === activeIndex}
					class="flex items-center gap-3 p-3 transition-colors {isTrack(result)
						? 'cursor-default'
						: 'cursor-pointer hover:bg-base-300'} {i === activeIndex ? 'bg-base-300' : ''}"
					onclick={() => !isTrack(result) && handleSelect(result)}
					onkeydown={(e) => {
						if (e.key === 'Enter' || e.key === ' ') handleSelect(result);
					}}
					tabindex="-1"
				>
					<div class="flex-none">
						<div
							class="relative w-10 h-10 bg-base-300 rounded overflow-hidden flex items-center justify-center group-hover:shadow-sm"
						>
							{#if isTrack(result)}
								{#if result.album_image_url}
									<img
										src={result.album_image_url}
										alt={result.album}
										class="w-full h-full object-cover rounded"
									/>
								{:else}
									<Disc3 class="h-5 w-5 text-base-content/20" />
								{/if}
							{:else if imageErrors[result.musicbrainz_id]}
								<Disc3 class="h-5 w-5 text-base-content/20" />
							{:else}
								<img
									src={coverUrl(result)}
									alt={result.title}
									class="w-full h-full object-cover rounded"
									onerror={() => {
										imageErrors[result.musicbrainz_id] = true;
									}}
								/>
							{/if}
						</div>
					</div>
					<div class="flex-1 min-w-0">
						<div class="font-medium truncate">{result.title}</div>
						<div class="text-sm opacity-70 truncate">
							{#if isTrack(result)}
								{result.artist}{result.album ? ` · ${result.album}` : ''}
							{:else if result.type === 'album' && result.artist}
								{result.artist}
							{:else if result.type === 'artist'}
								Artist
							{/if}
							{#if !isTrack(result)}
								{#if result.year}
									&middot; {result.year}
								{/if}
								{#if result.disambiguation}
									({result.disambiguation})
								{/if}
							{/if}
						</div>
					</div>
					<div class="flex items-center gap-2">
						{#if isTrack(result)}
							<div class="flex items-center gap-0.5">
								<StreamButton
									artist={result.artist}
									title={result.title}
									album={result.album}
									coverUrl={result.album_image_url}
									size="xs"
									wrapperClass="contents"
								/>
								<button
									class="btn btn-ghost btn-circle btn-xs h-7 w-7 min-h-0 min-w-0 -ml-1"
									onclick={(event) => requestTrack(result, event)}
									onmousedown={(event) => event.preventDefault()}
									disabled={download.isPending || requestedTracks.has(result.spotify_id)}
									aria-label="Request {result.title}"
									title="Request this track"
								>
									{#if download.isPending}
										<span class="loading loading-spinner loading-xs"></span>
									{:else if requestedTracks.has(result.spotify_id)}
										<Check class="h-4 w-4 text-success" />
									{:else}
										<Download class="h-4 w-4" />
									{/if}
								</button>
							</div>
						{/if}
						{#if !isTrack(result) && result.in_library}
							<span class="badge badge-sm badge-success">In Library</span>
						{/if}
						{#if !isTrack(result) && result.requested}
							<span class="badge badge-sm badge-warning">Requested</span>
						{/if}
						<span class="badge badge-sm badge-ghost">
							{result.type === 'artist' ? 'Artist' : result.type === 'album' ? 'Album' : 'Track'}
						</span>
					</div>
				</li>
			{/each}

			{#if suggestions.length > 0}
				<li class="p-3 text-center border-t border-base-300">
					<button class="text-sm link link-hover opacity-70" onclick={handleViewAll}>
						View all results
					</button>
				</li>
			{/if}

			{#if loading && suggestions.length === 0}
				<li class="p-4 flex justify-center">
					<span class="loading loading-spinner loading-md"></span>
				</li>
			{/if}
		</ul>
	{/if}
</div>

<style>
	.suggestion-dropdown {
		animation: suggestion-slide-in 150ms ease-out;
	}

	@keyframes suggestion-slide-in {
		from {
			opacity: 0;
			transform: translateY(-0.35rem);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.suggestion-dropdown {
			animation: none;
		}
	}
</style>
