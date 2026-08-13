<script lang="ts">
	import { CircleCheck, CircleX, FolderDown, Youtube } from 'lucide-svelte';

	import {
		getSpotiflacConfigQuery,
		saveSpotiflacConfig,
		testSpotiflac
	} from '$lib/queries/downloads/DownloadClientsQueries.svelte';
	import { toastStore } from '$lib/stores/toast';
	import type { SpotiflacConnectionSettings, SpotiflacTestResult } from '$lib/types';

	import DownloadClientCard from './DownloadClientCard.svelte';

	const configQuery = getSpotiflacConfigQuery();
	const save = saveSpotiflacConfig();
	const test = testSpotiflac();

	let enabled = $state(false);
	let downloadsMount = $state('/spotiflac-downloads');
	let quality = $state<SpotiflacConnectionSettings['quality']>('LOSSLESS');
	let seeded = $state(false);
	let testResult = $state<SpotiflacTestResult | null>(null);

	$effect(() => {
		const settings = configQuery.data;
		if (settings && !seeded) {
			enabled = settings.enabled;
			downloadsMount = settings.downloads_mount || '/spotiflac-downloads';
			quality = settings.quality || 'LOSSLESS';
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

	function current(): SpotiflacConnectionSettings {
		return { enabled, client_type: 'spotiflac', downloads_mount: downloadsMount, quality };
	}

	async function onSave() {
		try {
			await save.mutateAsync(current());
			toastStore.show({ message: 'SpotiFLAC settings saved', type: 'success' });
		} catch {
			toastStore.show({ message: 'Could not save SpotiFLAC settings', type: 'error' });
		}
	}

	async function onToggle() {
		try {
			await save.mutateAsync(current());
			toastStore.show({
				message: `SpotiFLAC ${enabled ? 'enabled' : 'disabled'}`,
				type: 'success'
			});
		} catch {
			enabled = !enabled;
			toastStore.show({ message: 'Could not update SpotiFLAC', type: 'error' });
		}
	}

	async function onTest() {
		try {
			testResult = await test.mutateAsync();
		} catch {
			testResult = { valid: false, message: "Couldn't run SpotiFLAC" };
		}
	}
</script>

{#if configQuery.isLoading}
	<div class="skeleton h-28 w-full rounded-box"></div>
{:else if configQuery.isError}
	<div class="alert alert-error">
		Failed to load SpotiFLAC settings: {configQuery.error.message}
	</div>
{:else}
	<DownloadClientCard
		title="spotbye"
		sourceLabel="SpotiFLAC"
		icon={Youtube}
		{connected}
		{statusText}
		bind:enabled
		{onToggle}
		enableAriaLabel="Enable SpotiFLAC download client"
	>
		<div class="alert alert-warning items-start text-sm">
			<Youtube class="size-5 shrink-0" aria-hidden="true" />
			<p>
				SpotiFLAC matches Spotify metadata against external audio providers. Only download material
				you are authorised to obtain, and expect provider availability to vary.
			</p>
		</div>

		<section class="space-y-3">
			<div class="flex flex-wrap items-center gap-3">
				<button
					type="button"
					class="btn btn-outline btn-sm"
					onclick={onTest}
					disabled={test.isPending}
				>
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
				<label class="label" for="spotiflac-quality"
					><span class="label-text">Maximum downloaded quality</span></label
				>
				<select id="spotiflac-quality" class="select select-bordered" bind:value={quality}>
					{#each ['LOW', 'HIGH', 'LOSSLESS', 'HI_RES_LOSSLESS'] as option (option)}
						<option value={option}>{option.replaceAll('_', ' ')}</option>
					{/each}
				</select>
				<p class="mt-1 text-xs text-base-content/60">
					LOW uses YouTube for lossy output. HIGH, LOSSLESS, and HI-RES LOSSLESS use the
					available provider output.
				</p>
			</div>

			<div class="space-y-1.5 rounded-box border border-base-content/10 bg-base-200/40 p-3">
				<div class="flex items-center gap-2 text-sm font-semibold">
					<FolderDown class="size-4 text-base-content/70" aria-hidden="true" /> Downloads mount
				</div>
				<p class="text-xs text-base-content/60">
					A writable directory mounted into Addonify. SpotiFLAC output will be imported from here.
				</p>
				<input
					id="spotiflac-mount"
					type="text"
					class="input input-sm input-bordered w-full font-mono"
					bind:value={downloadsMount}
					placeholder="/spotiflac-downloads"
				/>
			</div>
		</section>

		<p class="text-xs leading-relaxed text-base-content/60">
			SpotiFLAC is bundled with the Addonify image. This client configuration prepares its local
			output location and requested quality; direct request routing will be enabled with the next
			acquisition-source update.
		</p>

		<div class="flex justify-end">
			<button class="btn btn-primary" onclick={onSave} disabled={save.isPending}>
				{#if save.isPending}<span class="loading loading-spinner loading-sm"></span>{/if}
				Save settings
			</button>
		</div>
	</DownloadClientCard>
{/if}
