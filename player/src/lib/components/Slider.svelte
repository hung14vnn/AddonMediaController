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
	const percentage = $derived(max > 0 ? Math.min(1, Math.max(0, shown / max)) : 0);

	function setFromPointer(event: PointerEvent, element: HTMLElement) {
		const rect = element.getBoundingClientRect();
		const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
		const next = ratio * (max || 1);
		dragValue = next;
		oninput?.(next);
		return next;
	}

	function startDrag(event: PointerEvent) {
		if (!event.isPrimary) return;
		const element = event.currentTarget;
		if (!(element instanceof HTMLElement)) return;
		dragging = true;
		dragValue = value;
		element.setPointerCapture(event.pointerId);
		setFromPointer(event, element);
	}

	function moveDrag(event: PointerEvent) {
		if (!dragging || !event.isPrimary) return;
		const element = event.currentTarget;
		if (element instanceof HTMLElement) setFromPointer(event, element);
	}

	function endDrag(event: PointerEvent) {
		if (!dragging || !event.isPrimary) return;
		const element = event.currentTarget;
		const next = element instanceof HTMLElement ? setFromPointer(event, element) : dragValue;
		dragging = false;
		oninput?.(null);
		onchange(next);
		if (element instanceof HTMLElement && element.hasPointerCapture(event.pointerId)) {
			element.releasePointerCapture(event.pointerId);
		}
	}

	function onKeydown(event: KeyboardEvent) {
		const stepValue = step || (max || 1) / 100;
		let next = shown;
		if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next -= stepValue;
		else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next += stepValue;
		else if (event.key === 'Home') next = 0;
		else if (event.key === 'End') next = max || 1;
		else return;
		event.preventDefault();
		next = Math.min(max || 1, Math.max(0, next));
		onchange(next);
	}
</script>

<div
	class="slider"
	class:dragging
	role="slider"
	tabindex="0"
	aria-label={label}
	aria-valuemin="0"
	aria-valuemax={max || 1}
	aria-valuenow={shown}
	onpointerdown={startDrag}
	onpointermove={moveDrag}
	onpointerup={endDrag}
	onpointercancel={endDrag}
	onkeydown={onKeydown}
>
	<!-- The fill slides in rather than scaling, so its rounded end keeps its shape. -->
	<span class="track">
		<span class="fill" style:transform={`translateX(${(percentage - 1) * 100}%)`}></span>
	</span>
</div>

<style>
	.slider {
		--h: 4px;
		position: relative;
		width: 100%;
		height: 16px;
		margin: 0;
		cursor: pointer;
		touch-action: none;
	}
	.slider:hover,
	.slider.dragging {
		--h: 7px;
	}
	.track {
		position: absolute;
		top: calc(50% - var(--h) / 2);
		left: 0;
		right: 0;
		height: var(--h);
		border-radius: 99px;
		background: var(--slider-track, var(--fill-strong));
		overflow: hidden;
	}
	.fill {
		position: absolute;
		inset: 0;
		border-radius: 99px;
		background: var(--slider-fill, var(--text-2));
		will-change: transform;
	}
	.slider:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
		border-radius: 4px;
	}
</style>