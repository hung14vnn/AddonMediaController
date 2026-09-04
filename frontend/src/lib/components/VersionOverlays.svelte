<script lang="ts">
	import {
		getUpdateCheckQuery,
		getVersionQuery,
		getReleaseHistoryQuery
	} from '$lib/queries/VersionQuery.svelte';
	import { isWhatsNewDismissed } from '$lib/stores/version.svelte';
	import UpdateBanner from '$lib/components/UpdateBanner.svelte';
	import WhatsNewModal from '$lib/components/WhatsNewModal.svelte';

	let { updateAvailable = $bindable(false) }: { updateAvailable: boolean } = $props();

	const updateCheckQuery = getUpdateCheckQuery();
	const versionQuery = getVersionQuery();

	const currentVersion = $derived(versionQuery.data?.version ?? null);
	const buildDate = $derived(versionQuery.data?.build_date ?? null);
	const isDev = $derived(currentVersion === 'dev' || currentVersion === 'hosting-local');

	// Release history is only needed for the global What's New modal. Once a user
	// has dismissed the current release, avoid mounting the query observer and its
	// release-history request on every authenticated page.
	const releaseHistoryQuery = getReleaseHistoryQuery(() => {
		if (!currentVersion) return false;
		if (isDev) return true;
		const latestTag =
			updateCheckQuery.data?.latest_release?.tag_name ?? updateCheckQuery.data?.latest_version;
		return !latestTag || !isWhatsNewDismissed(latestTag);
	});

	function getMinorPrefix(tag: string): string | null {
		const m = tag.replace(/^v/, '').match(/^(\d+\.\d+)\./);
		return m ? m[1] : null;
	}

	// Collect releases sharing the same minor version, up to and including the current version
	const minorReleases = $derived.by(() => {
		const releases = releaseHistoryQuery.data;
		if (!releases || releases.length === 0) return [];

		if (isDev) {
			const prefix = getMinorPrefix(releases[0].tag_name);
			if (!prefix) return [releases[0]];
			return releases.filter((r) => !r.prerelease && getMinorPrefix(r.tag_name) === prefix);
		}

		if (!currentVersion) return [];

		const prefix = getMinorPrefix(currentVersion);
		if (!prefix) {
			const exact = releases.find((r) => r.tag_name === currentVersion);
			return exact ? [exact] : [];
		}

		// Same minor, then slice from the current version downward (releases are newest-first)
		const sameMinor = releases.filter(
			(r) => !r.prerelease && getMinorPrefix(r.tag_name) === prefix
		);
		const currentIdx = sameMinor.findIndex((r) => r.tag_name === currentVersion);
		if (currentIdx === -1) return sameMinor;
		return sameMinor.slice(currentIdx);
	});

	$effect(() => {
		updateAvailable = updateCheckQuery.data?.update_available ?? false;
	});
</script>

<UpdateBanner
	updateAvailable={updateCheckQuery.data?.update_available ?? false}
	latestVersion={updateCheckQuery.data?.latest_version ?? null}
/>
<WhatsNewModal {currentVersion} {buildDate} releases={minorReleases} />
