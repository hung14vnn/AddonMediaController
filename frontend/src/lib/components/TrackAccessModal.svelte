<script lang="ts">
	import { API } from '$lib/constants';
	import { api } from '$lib/api/client';
	import { toastStore } from '$lib/stores/toast';
	import type { NativeTrackListItem } from '$lib/types';
	import { Loader2, X } from 'lucide-svelte';

	type AccessUser = {
		id: string;
		display_name: string;
		role: string;
	};

	type AccessResponse = {
		users: AccessUser[];
		direct_user_ids: string[];
		album_user_ids: string[];
		user_ids: string[];
	};

	let {
		track,
		onclose
	}: {
		track: NativeTrackListItem | null;
		onclose: () => void;
	} = $props();

	let users = $state<AccessUser[]>([]);
	let directUserIds = $state<string[]>([]);
	let albumUserIds = $state<string[]>([]);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let mutatingUserId = $state<string | null>(null);
	let requestVersion = 0;

	function reset() {
		users = [];
		directUserIds = [];
		albumUserIds = [];
		loading = false;
		error = null;
		mutatingUserId = null;
	}

	async function load(trackId: string, version: number) {
		loading = true;
		error = null;
		try {
			const response = await api.get<AccessResponse>(
				API.library.adminTrackOwnershipAssignment(trackId)
			);
			if (version !== requestVersion) return;
			users = response.users;
			directUserIds = response.direct_user_ids;
			albumUserIds = response.album_user_ids;
		} catch (cause: unknown) {
			if (version !== requestVersion) return;
			error = cause instanceof Error ? cause.message : 'Could not load track access';
		} finally {
			if (version === requestVersion) loading = false;
		}
	}

	$effect(() => {
		const selectedTrack = track;
		const version = ++requestVersion;
		if (!selectedTrack) {
			reset();
			return;
		}
		reset();
		void load(selectedTrack.id, version);
	});

	function hasDirectAccess(userId: string) {
		return directUserIds.includes(userId);
	}

	function hasAlbumAccess(userId: string) {
		return albumUserIds.includes(userId);
	}

	function hasAccess(userId: string) {
		return hasDirectAccess(userId) || hasAlbumAccess(userId);
	}

	function sourceLabel(userId: string) {
		if (hasDirectAccess(userId) && hasAlbumAccess(userId)) return 'Direct + album assignment';
		if (hasDirectAccess(userId)) return 'Direct track assignment';
		if (hasAlbumAccess(userId)) return 'Album assignment';
		return 'Not assigned';
	}

	async function toggleAccess(userId: string) {
		if (!track || mutatingUserId || !track.musicbrainz_recording_id) return;
		const assigned = hasDirectAccess(userId);
		mutatingUserId = userId;
		try {
			const url = API.library.adminTrackOwnershipAssignment(track.id);
			if (assigned) await api.delete(url, { body: { user_id: userId } });
			else await api.post(url, { user_id: userId });
			directUserIds = assigned
				? directUserIds.filter((id) => id !== userId)
				: [...directUserIds, userId];
			toastStore.show({
				message: assigned ? 'Track removed from user library' : 'Track assigned to user',
				type: 'success'
			});
		} catch (cause: unknown) {
			toastStore.show({
				message: cause instanceof Error ? cause.message : 'Could not update track access',
				type: 'error'
			});
		} finally {
			mutatingUserId = null;
		}
	}
</script>

{#if track}
	<dialog class="modal modal-open" aria-labelledby="track-access-title">
		<div class="modal-box max-w-3xl">
			<div class="flex items-start justify-between gap-4">
				<div class="min-w-0">
					<h3 id="track-access-title" class="text-lg font-bold">Track access</h3>
					<p class="mt-1 truncate text-sm text-base-content/60">
						{track.title} · {track.artist_name}
					</p>
				</div>
				<button class="btn btn-sm btn-circle btn-ghost" onclick={onclose} aria-label="Close">
					<X class="h-4 w-4" />
				</button>
			</div>

			{#if !track.musicbrainz_recording_id}
				<div class="alert alert-warning mt-4 py-2 text-sm">
					This track has no MusicBrainz recording ID, so it cannot be assigned individually.
				</div>
			{/if}

			{#if error}
				<div class="alert alert-error mt-4">{error}</div>
			{:else if loading}
				<div class="flex items-center justify-center gap-2 py-12 text-sm text-base-content/60">
					<Loader2 class="h-5 w-5 animate-spin" />
					Loading users...
				</div>
			{:else}
				<div class="mt-4 max-h-[60vh] overflow-auto rounded-box border border-base-content/10">
					<table class="table table-sm">
						<thead>
							<tr>
								<th>User</th>
								<th>Role</th>
								<th>Has track</th>
								<th>Source</th>
							</tr>
						</thead>
						<tbody>
							{#each users as user (user.id)}
								{@const inherited = hasAlbumAccess(user.id) && !hasDirectAccess(user.id)}
								<tr>
									<td class="font-medium">{user.display_name}</td>
									<td><span class="badge badge-ghost badge-sm">{user.role}</span></td>
									<td>
										<input
											type="checkbox"
											class="checkbox checkbox-sm"
											checked={hasAccess(user.id)}
											disabled={inherited || !!mutatingUserId || !track.musicbrainz_recording_id}
											onchange={() => void toggleAccess(user.id)}
											aria-label={`Toggle track access for ${user.display_name}`}
										/>
									</td>
									<td class="text-xs text-base-content/60">
										{sourceLabel(user.id)}
										{#if inherited}
											<span class="block text-[10px]">Inherited from album</span>
										{/if}
										</td>
								</tr>
							{:else}
								<tr>
									<td colspan="4" class="py-8 text-center text-sm text-base-content/50">
										No users found.
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}

			<div class="modal-action">
				<button class="btn" onclick={onclose}>Close</button>
			</div>
		</div>
		<form method="dialog" class="modal-backdrop"><button onclick={onclose}>close</button></form>
	</dialog>
{/if}
