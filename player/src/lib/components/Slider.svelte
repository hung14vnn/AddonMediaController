<script lang="ts">
	// Thin Apple-style slider that thickens while hovered or dragged. Holds its own
	// value during a drag so playback time updates don't fight the pointer.
	let {
		value,
		max,
		label,
		step = 0.1,
		onchange,
		oninput
	}: {
		value: number;
		max: number;
		label: string;
		step?: number;
		onchange: (v: number) => void;
		oninput?: (v: number | null) => void;
	} = $props();

	let dragging = $state(false);
	let dragValue = $state(0);
	const shown = $derived(dragging ? dragValue : value);


	const pct = $derived.by(() => {
		if (max <= 0) return '0';
		const raw = Math.min(100, (shown / max) * 100);
		return raw.toFixed(1);
	});
</script>

<input
	class="slider"
	class:dragging
	type="range"
	min="0"
	max={max || 1}
	{step}
	value={shown}
	aria-label={label}
	style:--pct="{pct}%"
	onpointerdown={() => {
		dragging = true;
		dragValue = value;
	}}
	oninput={(e) => {
		dragValue = +e.currentTarget.value;
		if (!dragging) onchange(dragValue);
		oninput?.(dragValue);
	}}
	onchange={(e) => {
		dragging = false;
		oninput?.(null);
		onchange(+e.currentTarget.value);
	}}
/>

<style>
	.slider {
		--h: 4px;
		appearance: none;
		-webkit-appearance: none;
		width: 100%;
		height: 16px;
		margin: 0;
		background: transparent;
		cursor: pointer;
		touch-action: none;
	}
	.slider:hover,
	.slider.dragging {
		--h: 7px;
	}
	.slider::-webkit-slider-runnable-track {
		height: var(--h);
		border-radius: 99px;
		background: linear-gradient(
			to right,
			var(--slider-fill, var(--text-2)) var(--pct),
			var(--slider-track, var(--fill-strong)) var(--pct)
		);
		/* TỐI ƯU 2: Dùng transform thay vì transition height để không gây Reflow Layout */
		transform-origin: center;
		will-change: transform;
	}
	.slider::-moz-range-track {
		height: var(--h);
		border-radius: 99px;
		background: linear-gradient(
			to right,
			var(--slider-fill, var(--text-2)) var(--pct),
			var(--slider-track, var(--fill-strong)) var(--pct)
		);
	}
	.slider::-webkit-slider-thumb {
		-webkit-appearance: none;
		width: 0;
		height: var(--h);
		border: 0;
		background: transparent;
	}
	.slider::-moz-range-thumb {
		width: 0;
		height: 0;
		border: 0;
		background: transparent;
	}
	.slider:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
		border-radius: 4px;
	}
</style>