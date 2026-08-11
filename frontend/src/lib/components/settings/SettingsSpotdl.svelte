<script lang="ts">
	import { CircleCheck, CircleX, FolderDown, Youtube } from 'lucide-svelte';

	import {
		getSpotdlConfigQuery,
		saveSpotdlConfig,
		testSpotdl
	} from '$lib/queries/downloads/DownloadClientsQueries.svelte';
	import { toastStore } from '$lib/stores/toast';
	import type { SpotdlConnectionSettings, SpotdlTestResult } from '$lib/types';

	import DownloadClientCard from './DownloadClientCard.svelte';

	const configQuery = getSpotdlConfigQuery();
	const save = saveSpotdlConfig();
	const test = testSpotdl();

	let enabled = $state(false);
	let downloadsMount = $state('/spotdl-downloads');
	let format = $state<SpotdlConnectionSettings['format']>('mp3');
	let seeded = $state(false);
	let testResult = $state<SpotdlTestResult | null>(null);

	$effect(() => {
		const settings = configQuery.data;
		if (settings && !seeded) {
			enabled = settings.enabled;
			downloadsMount = settings.downloads_mount || '/spotdl-downloads';
			format = settings.format || 'mp3';
			seeded = true;
		}
	});

	const connected = $derived(testResult?.valid === true);
	const statusText = $derived(
		connected
			? `Installed${testResult?.version ? ` · v${testResult.version}` : ''}`
			: enabled
				? 'Check installation before enabling downloads'
				: 'Disabled'
	);

	function current(): SpotdlConnectionSettings {
		return { enabled, client_type: 'spotdl', downloads_mount: downloadsMount, format };
	}

	async function onSave() {
		try {
			await save.mutateAsync(current());
			toastStore.show({ message: 'spotDL settings saved', type: 'success' });
		} catch {
			toastStore.show({ message: 'Could not save spotDL settings', type: 'error' });
		}
	}

	async function onToggle() {
		try {
			await save.mutateAsync(current());
			toastStore.show({ message: `spotDL ${enabled ? 'enabled' : 'disabled'}`, type: 'success' });
		} catch {
			enabled = !enabled;
			toastStore.show({ message: 'Could not update spotDL', type: 'error' });
		}
	}

	async function onTest() {
		try {
			testResult = await test.mutateAsync();
		} catch {
			testResult = { valid: false, message: "Couldn't run spotDL" };
		}
	}
</script>

{#if configQuery.isLoading}
	<div class="skeleton h-28 w-full rounded-box"></div>
{:else if configQuery.isError}
	<div class="alert alert-error">Failed to load spotDL settings: {configQuery.error.message}</div>
{:else}
	<DownloadClientCard
		title="spotDL"
		sourceLabel="Spotify → YouTube"
		icon={Youtube}
		{connected}
		{statusText}
		bind:enabled
		{onToggle}
		enableAriaLabel="Enable spotDL download client"
	>
		<div class="alert alert-warning items-start text-sm">
			<Youtube class="size-5 shrink-0" aria-hidden="true" />
			<p>
				spotDL finds audio on YouTube for Spotify metadata. Only download material you are authorised to
				obtain, and expect source availability and quality to vary.
			</p>
		</div>

		<section class="space-y-3">
			<div class="flex flex-wrap items-center gap-3">
				<button type="button" class="btn btn-outline btn-sm" onclick={onTest} disabled={test.isPending}>
					{#if test.isPending}<span class="loading loading-spinner loading-xs"></span>{/if}
					Check installation
				</button>
				{#if testResult}
					<span
						class="flex items-center gap-1.5 text-sm"
						class:text-success={testResult.valid}
						class:text-error={!testResult.valid}
					>
						{#if testResult.valid}
							<CircleCheck class="size-4" aria-hidden="true" /> {testResult.message}
						{:else}
							<CircleX class="size-4" aria-hidden="true" /> {testResult.message}
						{/if}
					</span>
				{/if}
			</div>

			<div class="form-control">
				<label class="label" for="spotdl-format"><span class="label-text">Output format</span></label>
				<select id="spotdl-format" class="select select-bordered" bind:value={format}>
					{#each ['mp3', 'flac', 'm4a', 'ogg', 'opus', 'wav'] as outputFormat (outputFormat)}
						<option value={outputFormat}>{outputFormat.toUpperCase()}</option>
					{/each}
				</select>
			</div>

			<div class="space-y-1.5 rounded-box border border-base-content/10 bg-base-200/40 p-3">
				<div class="flex items-center gap-2 text-sm font-semibold">
					<FolderDown class="size-4 text-base-content/70" aria-hidden="true" /> Downloads mount
				</div>
				<p class="text-xs text-base-content/60">
					A writable directory mounted into DroppedNeedle. spotDL output will be imported from here.
				</p>
				<input
					id="spotdl-mount"
					type="text"
					class="input input-sm input-bordered w-full font-mono"
					bind:value={downloadsMount}
					placeholder="/spotdl-downloads"
				/>
			</div>
		</section>

		<p class="text-xs leading-relaxed text-base-content/60">
			spotDL is bundled with the DroppedNeedle image. This client configuration prepares its local output
			location and format; direct request routing will be enabled with the next acquisition-source update.
		</p>

		<div class="flex justify-end">
			<button class="btn btn-primary" onclick={onSave} disabled={save.isPending}>
				{#if save.isPending}<span class="loading loading-spinner loading-sm"></span>{/if}
				Save settings
			</button>
		</div>
	</DownloadClientCard>
{/if}
