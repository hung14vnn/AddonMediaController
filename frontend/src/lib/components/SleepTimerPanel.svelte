<script lang="ts">
	import { sleepTimerStore } from '$lib/stores/sleepTimer.svelte';
	import { Moon, X, Play } from 'lucide-svelte';
	import { fly } from 'svelte/transition';

	let { open = $bindable(), onclose }: { open: boolean; onclose: () => void } = $props();

	const PRESETS = [15, 30, 45, 60, 90];

	function formatPreset(minutes: number): string {
		return `${minutes}:00`;
	}
</script>

{#if open}
	<div
		class="fixed inset-0 z-[80]"
		role="presentation"
		onclick={onclose}
		onkeydown={(e) => {
			if (e.key === 'Escape') onclose();
		}}
	></div>

	<div
		transition:fly={{ y: 8, duration: 160 }}
		class="absolute bottom-full right-0 mb-2 z-[81] w-72 rounded-box border border-base-300 bg-base-100 shadow-2xl"
		role="dialog"
		aria-label="Sleep timer"
	>
		<div class="flex items-center justify-between px-4 pt-3 pb-2">
			<h3 class="text-sm font-semibold flex items-center gap-2">
				<Moon class="h-4 w-4" />
				Sleep timer
			</h3>
			<button
				class="btn btn-ghost btn-xs btn-circle"
				onclick={onclose}
				aria-label="Close sleep timer panel"
			>
				<X class="h-3.5 w-3.5" />
			</button>
		</div>

		{#if sleepTimerStore.isActive}
			<div class="px-4 py-3 border-t border-base-200">
				<p class="text-xs opacity-70 mb-3">
					{#if sleepTimerStore.isCountdown}
						Playback pauses in <span class="font-semibold text-accent"
							>{sleepTimerStore.remainingLabel}</span
						>.
					{:else}
						<span class="font-semibold text-accent">End of track</span> — playback pauses after the current
						track.
					{/if}
				</p>
				<button
					class="btn btn-outline btn-error btn-xs w-full gap-1"
					onclick={sleepTimerStore.cancel}
				>
					<X class="h-3 w-3" />
					Cancel sleep timer
				</button>
			</div>
		{/if}

		<div class="px-4 pb-4 pt-2 grid grid-cols-3 gap-2">
			{#each PRESETS as minutes (minutes)}
				<button
					class="btn btn-ghost btn-sm justify-center"
					class:btn-accent={sleepTimerStore.isCountdown &&
						sleepTimerStore.remainingLabel === formatPreset(minutes)}
					onclick={() => {
						sleepTimerStore.setMinutes(minutes);
						onclose();
					}}
				>
					{minutes}m
				</button>
			{/each}
			<button
				class="btn btn-ghost btn-sm justify-center"
				class:btn-accent={sleepTimerStore.isEndOfTrack}
				onclick={() => {
					sleepTimerStore.setEndOfTrack();
					onclose();
				}}
			>
				<Play class="h-3 w-3" />
				End
			</button>
		</div>
	</div>
{/if}
