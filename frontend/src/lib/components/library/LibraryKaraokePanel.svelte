<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { FolderOpen, Mic2, RefreshCw, Search, Trash2, WandSparkles, X } from 'lucide-svelte';

	import { api } from '$lib/api/client';
	import { API } from '$lib/constants';
	import type { KaraokeCacheEntry, KaraokeJobResponse, NativeTrackListItem } from '$lib/types';
	import {
		deleteKaraokeEntry,
		getKaraokeEntriesQuery
	} from '$lib/queries/library/KaraokeQueries.svelte';
	import { LibraryQueryKeyFactory } from '$lib/queries/library/LibraryQueryKeyFactory';
	import { toastStore } from '$lib/stores/toast';

	const entriesQuery = getKaraokeEntriesQuery();
	const removeEntry = deleteKaraokeEntry();

	let searchTerm = $state('');
	let debouncedSearch = $state('');
	let requesting = $state<
		Record<string, 'preparing' | 'queued' | 'processing' | 'ready' | 'failed'>
	>({});
	let requestErrors = $state<Record<string, string>>({});

	$effect(() => {
		const value = searchTerm.trim();
		const timer = window.setTimeout(() => (debouncedSearch = value), 220);
		return () => window.clearTimeout(timer);
	});

	const searchQuery = createQuery(() => {
		const term = debouncedSearch;
		return {
			enabled: term.length >= 2,
			staleTime: 30_000,
			queryKey: LibraryQueryKeyFactory.karaokeSearch(term),
			queryFn: ({ signal }) =>
				api.global.get<{ items: NativeTrackListItem[]; total: number }>(
					API.library.tracks(20, 0, 'title', term),
					{ signal }
				)
		};
	});
	const searchResults = $derived(searchQuery.data?.items ?? []);
	const searchLoading = $derived(searchQuery.isLoading);
	const searchError = $derived(
		searchQuery.isError
			? searchQuery.error instanceof Error
				? searchQuery.error.message
				: 'Could not search the library'
			: ''
	);

	function formatBytes(bytes: number): string {
		if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(bytes >= 1024 * 1024 * 100 ? 0 : 1)} MB`;
	}

	function entryLabel(entry: KaraokeCacheEntry): string {
		return entry.name;
	}

	function entryMetadata(entry: KaraokeCacheEntry): string {
		const details = [entry.artist_name, entry.album_name].filter(Boolean);
		return details.length > 0 ? details.join(' · ') : entry.relative_path;
	}

	function requestLabel(trackId: string): string {
		const state = requesting[trackId];
		if (state === 'preparing') return 'Preparing…';
		if (state === 'queued') return 'Queued';
		if (state === 'processing') return 'Creating…';
		if (state === 'ready') return 'Ready';
		if (state === 'failed') return 'Try again';
		return 'Request karaoke';
	}

	async function requestKaraoke(track: NativeTrackListItem): Promise<void> {
		const trackId = track.track_file_id ?? track.id;
		if (
			!trackId ||
			requesting[trackId] === 'preparing' ||
			requesting[trackId] === 'queued' ||
			requesting[trackId] === 'processing'
		)
			return;

		requesting[trackId] = 'preparing';
		requestErrors[trackId] = '';
		try {
			let job = await api.global.post<KaraokeJobResponse>(API.karaoke.prepare(), {
				track_file_id: trackId
			});
			let pollAttempt = 0;
			while (job.status === 'queued' || job.status === 'processing') {
				requesting[trackId] = job.status;
				if (!job.job_id) throw new Error('Karaoke job identifier is missing');
				await new Promise((resolve) =>
					window.setTimeout(resolve, Math.min(5000, 1800 + pollAttempt * 700))
				);
				job = await api.global.get<KaraokeJobResponse>(API.karaoke.job(job.job_id));
				pollAttempt += 1;
			}
			if (job.status === 'failed')
				throw new Error(job.error_message || 'Karaoke generation failed');
			requesting[trackId] = 'ready';
			toastStore.show({
				message: job.cached ? 'Karaoke was already ready' : 'Karaoke is ready',
				type: 'success'
			});
			await entriesQuery.refetch();
		} catch (error) {
			requesting[trackId] = 'failed';
			requestErrors[trackId] = error instanceof Error ? error.message : 'Karaoke generation failed';
			toastStore.show({ message: requestErrors[trackId], type: 'error' });
		}
	}

	function deleteEntry(entry: KaraokeCacheEntry): void {
		if (
			typeof window !== 'undefined' &&
			!window.confirm(`Remove karaoke cache for “${entryLabel(entry)}”?`)
		)
			return;
		removeEntry.mutate(entry.id);
	}
</script>

<div class="space-y-6">
	<section
		class="rounded-2xl border border-accent/20 bg-gradient-to-br from-accent/10 via-base-200/40 to-base-200/30 p-5 shadow-sm sm:p-6"
	>
		<div class="flex flex-wrap items-start justify-between gap-4">
			<div class="flex items-start gap-3">
				<div
					class="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-accent/15 text-accent"
				>
					<Mic2 class="h-5 w-5" aria-hidden="true" />
				</div>
				<div>
					<h2 class="text-lg font-semibold">Karaoke cache</h2>
					<p class="mt-1 max-w-2xl text-sm text-base-content/60">
						Manage generated vocal and instrumental stems. Older or unlinked karaoke folders are
						shown too.
					</p>
				</div>
			</div>
			<button
				type="button"
				class="btn btn-ghost btn-sm gap-2"
				disabled={entriesQuery.isFetching}
				onclick={() => void entriesQuery.refetch()}
				aria-label="Refresh karaoke cache"
			>
				<RefreshCw class={`h-4 w-4 ${entriesQuery.isFetching ? 'animate-spin' : ''}`} />
				Refresh
			</button>
		</div>

		{#if entriesQuery.isLoading}
			<div class="mt-5 space-y-3">
				<div class="skeleton h-16 rounded-xl"></div>
				<div class="skeleton h-16 rounded-xl"></div>
			</div>
		{:else if entriesQuery.isError}
			<div class="alert alert-error mt-5">Could not load the karaoke cache.</div>
		{:else if (entriesQuery.data?.items.length ?? 0) === 0}
			<div
				class="mt-5 rounded-xl border border-dashed border-base-content/15 bg-base-100/30 px-5 py-8 text-center"
			>
				<FolderOpen class="mx-auto h-8 w-8 text-base-content/30" />
				<p class="mt-2 font-medium">No karaoke tracks yet</p>
				<p class="mt-1 text-sm text-base-content/55">
					Search your library below to create the first one.
				</p>
			</div>
		{:else}
			<div class="mt-5 overflow-hidden rounded-xl border border-base-content/10 bg-base-100/35">
				<div
					class="flex items-center justify-between border-b border-base-content/10 px-4 py-3 text-xs font-semibold tracking-wide text-base-content/50 uppercase"
				>
					<span
						>{entriesQuery.data?.total ?? 0}
						{entriesQuery.data?.total === 1 ? 'track' : 'tracks'}</span
					>
					<span>Generated cache</span>
				</div>
				<div class="divide-y divide-base-content/8">
					{#each entriesQuery.data?.items ?? [] as entry (entry.id)}
						<div class="flex items-center gap-3 px-4 py-3 sm:gap-4">
							<div
								class="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-base-200 text-accent"
							>
								<Mic2 class="h-4 w-4" aria-hidden="true" />
							</div>
							<div class="min-w-0 flex-1">
								<div class="flex flex-wrap items-center gap-2">
									<p class="truncate font-medium">{entryLabel(entry)}</p>
									<span
										class="badge badge-sm {entry.status === 'ready'
											? 'badge-success'
											: entry.status === 'legacy'
												? 'badge-warning'
												: 'badge-error'}"
									>
										{entry.status === 'ready'
											? 'Ready'
											: entry.status === 'legacy'
												? 'Legacy'
												: 'Partial'}
									</span>
								</div>
								<p class="mt-0.5 truncate text-xs text-base-content/50">
									{entryMetadata(entry)} · {formatBytes(entry.size_bytes)}
								</p>
							</div>
							<button
								type="button"
								class="btn btn-ghost btn-sm btn-square text-error hover:bg-error/10"
								disabled={removeEntry.isPending}
								onclick={() => deleteEntry(entry)}
								aria-label={`Delete ${entryLabel(entry)}`}
								title="Delete karaoke cache"
							>
								<Trash2 class="h-4 w-4" aria-hidden="true" />
							</button>
						</div>
					{/each}
				</div>
			</div>
		{/if}
	</section>

	<section class="rounded-2xl border border-base-content/10 bg-base-200/35 p-5 sm:p-6">
		<div class="flex items-start gap-3">
			<div
				class="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-primary/15 text-primary"
			>
				<Search class="h-5 w-5" aria-hidden="true" />
			</div>
			<div>
				<h2 class="text-lg font-semibold">Request karaoke</h2>
				<p class="mt-1 text-sm text-base-content/60">
					Find a downloaded track and generate its karaoke stems.
				</p>
			</div>
		</div>

		<label class="input input-bordered mt-5 flex w-full items-center gap-2 bg-base-100/50">
			<Search class="h-4 w-4 text-base-content/40" aria-hidden="true" />
			<input
				bind:value={searchTerm}
				type="search"
				placeholder="Search library tracks…"
				aria-label="Search library tracks"
			/>
			{#if searchTerm}
				<button
					type="button"
					class="btn btn-ghost btn-xs btn-circle"
					aria-label="Clear track search"
					onclick={() => (searchTerm = '')}
				>
					<X class="h-4 w-4" />
				</button>
			{/if}
		</label>

		{#if debouncedSearch.length < 2}
			<p class="mt-4 text-sm text-base-content/50">
				Type at least 2 characters to search the local library.
			</p>
		{:else if searchLoading}
			<div class="mt-4 space-y-2">
				<div class="skeleton h-14 rounded-xl"></div>
				<div class="skeleton h-14 rounded-xl"></div>
			</div>
		{:else if searchError}
			<div class="alert alert-error mt-4 text-sm">{searchError}</div>
		{:else if searchResults.length === 0}
			<p class="mt-4 text-sm text-base-content/55">
				No library tracks matched “{debouncedSearch}”.
			</p>
		{:else}
			<div
				class="mt-4 divide-y divide-base-content/8 overflow-hidden rounded-xl border border-base-content/10 bg-base-100/30"
			>
				{#each searchResults as track (track.track_file_id ?? track.id)}
					{@const trackId = track.track_file_id ?? track.id}
					<div class="flex items-center gap-3 px-4 py-3">
						<div class="min-w-0 flex-1">
							<p class="truncate font-medium">{track.title}</p>
							<p class="truncate text-xs text-base-content/55">
								{track.artist_name}{track.album_name ? ` · ${track.album_name}` : ''}
							</p>
						</div>
						<button
							type="button"
							class="btn btn-primary btn-sm shrink-0 gap-2"
							disabled={requesting[trackId] === 'preparing' ||
								requesting[trackId] === 'queued' ||
								requesting[trackId] === 'processing' ||
								requesting[trackId] === 'ready'}
							onclick={() => void requestKaraoke(track)}
						>
							{#if requesting[trackId] === 'preparing' || requesting[trackId] === 'queued' || requesting[trackId] === 'processing'}
								<span class="loading loading-spinner loading-xs"></span>
							{:else}
								<WandSparkles class="h-4 w-4" aria-hidden="true" />
							{/if}
							{requestLabel(trackId)}
						</button>
					</div>
					{#if requestErrors[trackId]}
						<p class="px-4 pb-2 text-xs text-error">{requestErrors[trackId]}</p>
					{/if}
				{/each}
			</div>
		{/if}
	</section>
</div>
