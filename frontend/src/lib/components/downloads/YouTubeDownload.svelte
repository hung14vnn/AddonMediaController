<script lang="ts">
	import { ListPlus, Loader2, Music2, Pencil } from 'lucide-svelte';
	import YouTubeIcon from '$lib/components/YouTubeIcon.svelte';

	import { api } from '$lib/api/client';
	import { API } from '$lib/constants';
	import { invalidateQueriesWithPersister } from '$lib/queries/QueryClient';
	import { DownloadQueryKeyFactory } from '$lib/queries/downloads/DownloadQueryKeyFactory';
	import { toastStore } from '$lib/stores/toast';
	import { openGlobalPlaylistModal } from '$lib/stores/playlistModal.svelte';
	import type { QueueItem } from '$lib/player/types';
	import type { YTMusicStreamInfo } from '$lib/types';

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
	let addingToPlaylist = $state(false);
	let editingMetadata = $state(false);
	let editedTitle = $state('');
	let editedArtist = $state('');

	function duration(value: number | null): string {
		if (value == null) return '';
		const minutes = Math.floor(value / 60);
		const seconds = Math.round(value % 60)
			.toString()
			.padStart(2, '0');
		return `${minutes}:${seconds}`;
	}

	function finishMetadataEditing() {
		if (!preview) return;
		preview = {
			...preview,
			title: editedTitle.trim() || preview.title,
			uploader: editedArtist.trim() || preview.uploader
		};
		editingMetadata = false;
	}

	function extractVideoId(link: string): string | null {
		try {
			const u = new URL(link);
			if (u.searchParams.has('v')) return u.searchParams.get('v');
			if (u.hostname === 'youtu.be') return u.pathname.replace(/^\//, '');
		} catch {
			// ignore
		}
		const m = link.match(/(?:v=|\/)([0-9A-Za-z_-]{11})(?:\?|&|$)/);
		return m ? m[1] : null;
	}

	function parseArtistAndTitle(rawTitle: string, rawArtist: string): { title: string; artist: string } {
		const cleanTitle = rawTitle
			.replace(/[\(\[][^\)\]]*(?:mv|video|audio|official|visualizer|remaster|hd|4k)[^\)\]]*[\)\]]/gi, '')
			.trim();
		const cleanArtist = rawArtist.trim();

		if (cleanTitle.includes(' - ')) {
			const parts = cleanTitle.split(' - ');
			if (parts.length === 2) {
				const [p1, p2] = parts.map((s) => s.trim());
				if (cleanArtist && p1.toLowerCase() === cleanArtist.toLowerCase()) {
					return { artist: p1, title: p2 };
				}
				if (cleanArtist && p2.toLowerCase() === cleanArtist.toLowerCase()) {
					return { artist: p2, title: p1 };
				}
				if (!cleanArtist || cleanArtist.toLowerCase() === 'youtube' || cleanArtist.toLowerCase().includes('topic')) {
					return { artist: p1, title: p2 };
				}
				return { artist: p1, title: p2 };
			}
		}

		return {
			title: cleanTitle || rawTitle.trim(),
			artist: cleanArtist && cleanArtist.toLowerCase() !== 'youtube' ? cleanArtist : ''
		};
	}

	async function getPreview() {
		if (!url.trim()) return;
		loading = true;
		preview = null;
		try {
			preview = await api.global.post<Preview>(API.downloads.youtubePreview(), { url });
			editedTitle = preview.title;
			editedArtist = preview.uploader || 'YouTube';
			editingMetadata = false;
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
			const title = editedTitle.trim();
			const artist = editedArtist.trim();
			if (!title || !artist) return;
			await api.global.post<{ task_id: string }>(API.downloads.youtube(), {
				url: preview.url,
				track_title: title,
				artist_name: artist
			});
			toastStore.show({ message: 'YouTube audio download started', type: 'success' });
			url = '';
			preview = null;
			editingMetadata = false;
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

	async function addToPlaylist() {
		if (!preview) return;
		finishMetadataEditing();

		const currentTitle = editedTitle.trim() || preview.title;
		const currentArtist = editedArtist.trim() || preview.uploader || '';
		const { title, artist } = parseArtistAndTitle(currentTitle, currentArtist);

		addingToPlaylist = true;
		try {
			let matched = false;
			try {
				const info = await api.global.get<YTMusicStreamInfo>(API.ytmusicStream.search(artist, title));
				if (info?.video_id) {
					const queueItem: QueueItem = {
						trackSourceId: info.video_id,
						trackName: info.title || title,
						artistName: info.artist || artist || 'YouTube Music',
						albumName: 'YouTube Music',
						albumId: `ytmusic-${info.video_id}`,
						coverUrl: info.thumbnail ?? preview.thumbnail ?? null,
						sourceType: 'ytmusic',
						streamUrl: API.ytmusicStream.stream(info.video_id),
						duration: info.duration_s ?? preview.duration_seconds ?? undefined,
						availableSources: ['ytmusic'],
						trackNumber: 1
					};
					openGlobalPlaylistModal([queueItem]);
					matched = true;
				}
			} catch (searchErr) {
				console.warn('YTMusic search failed, falling back to video ID:', searchErr);
			}

			if (!matched) {
				const videoId = extractVideoId(preview.url || url);
				if (!videoId) {
					toastStore.show({
						message: 'Could not find a YouTube Music track or video ID',
						type: 'error'
					});
					return;
				}
				const queueItem: QueueItem = {
					trackSourceId: videoId,
					trackName: title,
					artistName: artist || preview.uploader || 'YouTube',
					albumName: 'YouTube Music',
					albumId: `ytmusic-${videoId}`,
					coverUrl: preview.thumbnail ?? null,
					sourceType: 'ytmusic',
					streamUrl: API.ytmusicStream.stream(videoId),
					duration: preview.duration_seconds ?? undefined,
					availableSources: ['ytmusic'],
					trackNumber: 1
				};
				openGlobalPlaylistModal([queueItem]);
			}
		} catch (err) {
			toastStore.show({
				message: err instanceof Error ? err.message : 'Failed to add to playlist',
				type: 'error'
			});
		} finally {
			addingToPlaylist = false;
		}
	}
</script>

<div class="rounded-2xl border border-base-content/10 bg-base-200/40 p-4 sm:p-6">
	<div class="flex items-center gap-2">
		<YouTubeIcon class="size-5 text-red-500" aria-hidden="true" />
		<h2 class="font-semibold">Download from YouTube</h2>
	</div>
	<p class="mt-1 text-sm text-base-content/60">
		Paste a video or playlist link. The best available audio is kept in its native codec—no fixed
		output format, quality cap, or duration/size limit.
	</p>

	<form
		class="mt-4 flex flex-col gap-2 sm:flex-row"
		onsubmit={(event) => {
			event.preventDefault();
			void getPreview();
		}}
	>
		<input
			class="input input-bordered w-full"
			placeholder="https://www.youtube.com/watch?v=..."
			bind:value={url}
			aria-label="YouTube link"
		/>
		<button
			class="btn btn-primary inline-flex items-center justify-center gap-2"
			disabled={loading || !url.trim()}
		>
			{#if loading}<Loader2
					class="size-4 shrink-0 origin-center animate-spin"
					aria-hidden="true"
				/>{/if}
			Get details
		</button>
	</form>

	{#if preview}
		<div class="mt-4 flex gap-4 rounded-xl bg-base-100 p-3">
			{#if preview.thumbnail}
				<img class="h-20 w-32 rounded-lg object-cover" src={preview.thumbnail} alt="" />
			{/if}
			<div class="min-w-0 flex-1">
				{#if editingMetadata}
					<div class="grid gap-2 sm:grid-cols-2">
						<label class="form-control">
							<span class="label-text text-xs text-base-content/60">Name</span>
							<input
								class="input input-bordered input-sm"
								bind:value={editedTitle}
								aria-label="Song name"
							/>
						</label>
						<label class="form-control">
							<span class="label-text text-xs text-base-content/60">Artist</span>
							<input
								class="input input-bordered input-sm"
								bind:value={editedArtist}
								aria-label="Artist name"
							/>
						</label>
					</div>
				{:else}
					<div class="flex items-center gap-2">
						<p class="truncate font-medium">{editedTitle || preview.title}</p>
						<button
							class="btn btn-ghost btn-xs btn-square"
							type="button"
							onclick={() => (editingMetadata = true)}
							aria-label="Edit song name and artist"
							title="Edit name and artist"
						>
							<Pencil class="size-3.5" aria-hidden="true" />
						</button>
					</div>
				{/if}
				<div class="mt-0.5 flex items-center gap-2 text-sm text-base-content/60">
					<p>
						{preview.uploader || 'YouTube'}{#if preview.duration_seconds != null}
							· {duration(preview.duration_seconds)}{/if}
					</p>
					<button
						class="btn btn-ghost btn-xs btn-square"
						type="button"
						onclick={() => (editingMetadata = true)}
						aria-label="Edit artist name"
						title="Edit artist name"
					>
						<Pencil class="size-3.5" aria-hidden="true" />
					</button>
				</div>
				<div class="mt-3 flex flex-wrap items-center gap-2">
					<button
						class="btn btn-primary btn-sm inline-flex items-center justify-center gap-2"
						onclick={queueDownload}
						disabled={queueing || addingToPlaylist}
					>
						{#if queueing}<Loader2
								class="size-4 shrink-0 origin-center animate-spin"
								aria-hidden="true"
							/>{:else}<Music2 class="size-4 shrink-0" aria-hidden="true" />{/if}
						Download audio
					</button>
					<button
						class="btn btn-outline btn-sm inline-flex items-center justify-center gap-2"
						type="button"
						onclick={addToPlaylist}
						disabled={queueing || addingToPlaylist}
					>
						{#if addingToPlaylist}
							<Loader2 class="size-4 shrink-0 animate-spin" aria-hidden="true" />
						{:else}
							<ListPlus class="size-4 shrink-0" aria-hidden="true" />
						{/if}
						Add to playlist
					</button>
					{#if editingMetadata}
						<button
							class="btn btn-ghost btn-sm"
							type="button"
							onclick={finishMetadataEditing}
							disabled={queueing || addingToPlaylist}>Done</button
						>
					{/if}
					<button class="btn btn-ghost btn-sm" onclick={() => (preview = null)} disabled={queueing || addingToPlaylist}
						>Change link</button
					>
				</div>
			</div>
		</div>
	{/if}
</div>
