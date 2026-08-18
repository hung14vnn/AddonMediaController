<script lang="ts">
	import { Loader2, Music2, Youtube } from 'lucide-svelte';

	import { api } from '$lib/api/client';
	import { API } from '$lib/constants';
	import { invalidateQueriesWithPersister } from '$lib/queries/QueryClient';
	import { DownloadQueryKeyFactory } from '$lib/queries/downloads/DownloadQueryKeyFactory';
	import { toastStore } from '$lib/stores/toast';

	type Preview = {
		url: string;
		title: string;
		uploader: string;
		duration_seconds: number | null;
		thumbnail: string | null;
	};

	let url = $state('');
	let preview = $state<Preview | null>(null);
	let loading = $state(false);
	let queueing = $state(false);

	function duration(value: number | null): string {
		if (value == null) return '';
		const minutes = Math.floor(value / 60);
		const seconds = Math.round(value % 60).toString().padStart(2, '0');
		return `${minutes}:${seconds}`;
	}

	async function getPreview() {
		if (!url.trim()) return;
		loading = true;
		preview = null;
		try {
			preview = await api.global.post<Preview>(API.downloads.youtubePreview(), { url });
		} catch (error) {
			toastStore.show({
				message: error instanceof Error ? error.message : "Couldn't read that YouTube link",
				type: 'error'
			});
		} finally {
			loading = false;
		}
	}

	async function queueDownload() {
		if (!preview) return;
		queueing = true;
		try {
			await api.global.post<{ task_id: string }>(API.downloads.youtube(), { url: preview.url });
			toastStore.show({ message: 'YouTube audio download started', type: 'success' });
			url = '';
			preview = null;
			await invalidateQueriesWithPersister({ queryKey: DownloadQueryKeyFactory.tasks() });
		} catch (error) {
			toastStore.show({
				message: error instanceof Error ? error.message : 'Could not start the download',
				type: 'error'
			});
		} finally {
			queueing = false;
		}
	}
</script>

<div class="rounded-2xl border border-base-content/10 bg-base-200/40 p-4 sm:p-6">
	<div class="flex items-center gap-2">
		<Youtube class="size-5 text-red-500" aria-hidden="true" />
		<h2 class="font-semibold">Download from YouTube</h2>
	</div>
	<p class="mt-1 text-sm text-base-content/60">
		Paste a video or playlist link. The best available audio is kept in its native codec—no
		fixed output format, quality cap, or duration/size limit.
	</p>

	<form class="mt-4 flex flex-col gap-2 sm:flex-row" onsubmit={(event) => { event.preventDefault(); void getPreview(); }}>
		<input
			class="input input-bordered w-full"
			placeholder="https://www.youtube.com/watch?v=..."
			bind:value={url}
			aria-label="YouTube link"
		/>
		<button class="btn btn-primary inline-flex items-center justify-center gap-2" disabled={loading || !url.trim()}>
			{#if loading}<Loader2 class="size-4 shrink-0 origin-center animate-spin" aria-hidden="true" />{/if}
			Get details
		</button>
	</form>

	{#if preview}
		<div class="mt-4 flex gap-4 rounded-xl bg-base-100 p-3">
			{#if preview.thumbnail}
				<img class="h-20 w-32 rounded-lg object-cover" src={preview.thumbnail} alt="" />
			{/if}
			<div class="min-w-0 flex-1">
				<p class="truncate font-medium">{preview.title}</p>
				<p class="mt-0.5 text-sm text-base-content/60">
					{preview.uploader || 'YouTube'}{#if preview.duration_seconds != null} · {duration(preview.duration_seconds)}{/if}
				</p>
				<div class="mt-3 flex items-center gap-2">
					<button class="btn btn-primary btn-sm inline-flex items-center justify-center gap-2" onclick={queueDownload} disabled={queueing}>
						{#if queueing}<Loader2 class="size-4 shrink-0 origin-center animate-spin" aria-hidden="true" />{:else}<Music2 class="size-4 shrink-0" aria-hidden="true" />{/if}
						Download audio
					</button>
					<button class="btn btn-ghost btn-sm" onclick={() => (preview = null)} disabled={queueing}>Change link</button>
				</div>
			</div>
		</div>
	{/if}
</div>
