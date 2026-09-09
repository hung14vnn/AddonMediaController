<script lang="ts">
	interface Props {
		percent?: number;
		bytesDownloaded?: number;
		bytesTotal?: number;
		filesCompleted?: number;
		filesTotal?: number;
		indeterminate?: boolean;
	}
	let { filesCompleted = 0, filesTotal = 0 }: Props = $props();
</script>

<div
	class="flex justify-end text-[11px] text-base-content/50 tabular-nums"
	role="status"
	aria-live="polite"
	aria-label="Download files"
>
	{#if filesTotal > 0}{filesCompleted}/{filesTotal} files{/if}
</div>
