<script lang="ts">
	import { LoaderCircle, Mic2, X } from 'lucide-svelte';
	import { karaokeController } from '$lib/stores/karaoke.svelte';

	const waiting = $derived(karaokeController.waiting);
	const status = $derived(karaokeController.status);
	const previewStatus = $derived(karaokeController.previewStatus);
	const previewPlaying = $derived(karaokeController.previewPlaying);
	const failed = $derived(status === 'failed');
	const error = $derived(karaokeController.error);

	const message = $derived.by(() => {
		if (failed) {
			return previewPlaying
				? 'The AI separation failed. You can keep singing with the quick vocal cut.'
				: error || 'Karaoke generation failed.';
		}
		if (previewPlaying) {
			return 'Sing along now — the full AI mix takes over automatically when it is ready.';
		}
		if (previewStatus === 'unavailable') {
			return 'This file cannot be cut live. The AI is separating the vocals, which can take a few minutes.';
		}
		return 'Cutting the vocal track so you can start singing while the AI separates this song.';
	});
</script>

{#if waiting}
	<div class="fixed inset-0 z-[100] grid place-items-center bg-black/45 p-4" role="presentation">
		<div
			class="w-full max-w-sm rounded-2xl border border-base-300 bg-base-100 p-5 shadow-2xl"
			role="dialog"
			aria-modal="true"
			aria-labelledby="karaoke-wait-title"
			aria-describedby="karaoke-wait-message"
		>
			<div class="flex items-start gap-3">
				<div class="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-accent/15 text-accent">
					<Mic2 class="h-5 w-5" aria-hidden="true" />
				</div>
				<div class="min-w-0 flex-1">
					<h2 id="karaoke-wait-title" class="text-base font-semibold">
						{failed ? 'Karaoke unavailable' : 'Preparing karaoke'}
					</h2>
					<p id="karaoke-wait-message" class="mt-1 text-sm text-base-content/65">
						{message}
					</p>
				</div>
				<button
					type="button"
					class="btn btn-ghost btn-xs btn-square shrink-0"
					aria-label="Hide karaoke progress"
					onclick={() => karaokeController.dismiss()}
				>
					<X class="h-4 w-4" />
				</button>
			</div>

			{#if !failed}
				<div class="mt-4 flex items-center gap-2 rounded-xl bg-base-200/60 px-3 py-2.5">
					<LoaderCircle class="h-4 w-4 animate-spin text-accent" aria-hidden="true" />
					<span class="text-sm text-base-content/70">
						{status === 'queued' ? 'Queued for separation' : 'Separating vocals in the background'}
					</span>
				</div>
			{/if}

			<div class="mt-4 flex justify-end gap-2">
				{#if !failed}
					<button type="button" class="btn btn-ghost btn-sm" onclick={() => karaokeController.dismiss()}>
						Hide
					</button>
				{/if}
				<button type="button" class="btn btn-sm" class:btn-error={failed} onclick={() => karaokeController.stop()}>
					Turn off karaoke
				</button>
			</div>
		</div>
	</div>
{/if}
