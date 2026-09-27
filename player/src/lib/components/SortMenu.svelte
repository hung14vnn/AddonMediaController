<script lang="ts">
	import Icon from './Icon.svelte';

	export type SortOption = { value: string; label: string };

	let {
		value,
		options,
		label = 'Sort',
		onchange
	}: {
		value: string;
		options: SortOption[];
		label?: string;
		onchange: (value: string) => void;
	} = $props();

	let open = $state(false);
	const selected = $derived(options.find((option) => option.value === value) ?? options[0]);

	function close() {
		open = false;
	}
</script>

<svelte:window onclick={close} />

<div class="sort">
	<button
		class="sort-button"
		type="button"
		aria-haspopup="listbox"
		aria-expanded={open}
		onclick={(event) => { event.stopPropagation(); open = !open; }}
	>
		<span class="sort-caption">{label}</span>
		<span class="sort-value">{selected?.label}</span>
		<Icon name="chevronDown" size={14} />
	</button>
	{#if open}
		<div class="sort-menu" role="listbox" aria-label={label}>
			{#each options as option}
				<button
					class="sort-option"
					class:selected={value === option.value}
					role="option"
					aria-selected={value === option.value}
					type="button"
					onclick={(event) => {
						event.stopPropagation();
						onchange(option.value);
						open = false;
					}}
				>
					<span>{option.label}</span>
					{#if value === option.value}<span class="check" aria-hidden="true">✓</span>{/if}
				</button>
			{/each}
		</div>
	{/if}
</div>

<style>
	.sort {
		position: relative;
		display: flex;
		align-items: center;
		margin-left: auto;
	}
	.sort-button {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		min-height: 32px;
		padding: 0 10px 0 12px;
		border: 0;
		border-radius: 9px;
		font: inherit;
		font-size: 13px;
		color: var(--accent);
		background: var(--fill);
		cursor: pointer;
		-webkit-tap-highlight-color: transparent;
	}
	.sort-button:active { transform: scale(0.98); }
	.sort-caption { color: var(--text-2); }
	.sort-value { font-weight: 600; }
	.sort-button :global(svg) { transition: transform 160ms ease; }
	.sort:has(.sort-menu) .sort-button :global(svg) { transform: rotate(180deg); }
	.sort-menu {
		position: absolute;
		top: calc(100% + 8px);
		right: 0;
		z-index: 20;
		width: max-content;
		min-width: 190px;
		padding: 6px;
		border: 1px solid var(--fill-strong);
		border-radius: 13px;
		background: var(--bg-elevated);
		box-shadow: 0 10px 28px rgb(0 0 0 / 0.18), 0 2px 6px rgb(0 0 0 / 0.1);
	}
	.sort-option {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 18px;
		width: 100%;
		min-height: 38px;
		padding: 0 10px;
		border: 0;
		border-radius: 8px;
		font: inherit;
		font-size: 14px;
		text-align: left;
		color: var(--text);
		background: transparent;
		cursor: pointer;
	}
	.sort-option:hover, .sort-option:focus-visible { background: var(--fill); outline: none; }
	.sort-option.selected { color: var(--accent); font-weight: 600; }
	.check { font-size: 18px; line-height: 1; font-weight: 700; }
</style>
