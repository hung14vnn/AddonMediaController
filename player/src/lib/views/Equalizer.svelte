<script lang="ts">
	// Apple Music's equalizer: the graphic EQ from Music on the Mac (ten bands,
	// ±12 dB) above the preset list from Settings › Music › EQ on iPhone.
	import Icon from "../components/Icon.svelte";
	import { audioSettings } from "../playback/audioSettings.svelte";
	import {
		EQ_LABELS,
		EQ_MAX_DB,
		EQ_MIN_DB,
		EQ_PRESET_NAMES,
	} from "../playback/eqPresets";
	import { getPlayer } from "../player.svelte";
	import { router } from "../router.svelte";

	const player = getPlayer();
	const RANGE = EQ_MAX_DB - EQ_MIN_DB;
	const STEP = 0.5;

	const usable = $derived(player.webAudio);
	const on = $derived(usable && audioSettings.eqEnabled);

	let dragging = $state<number | null>(null);
	let tracks: HTMLDivElement[] = [];

	/** 0 at the top (+12 dB) … 1 at the bottom (−12 dB). */
	const fraction = (db: number) => (EQ_MAX_DB - db) / RANGE;

	function formatDb(db: number) {
		return `${db > 0 ? "+" : db < 0 ? "−" : ""}${Math.abs(db).toFixed(1)} dB`;
	}

	function setFromPointer(i: number, e: PointerEvent) {
		const rect = tracks[i]?.getBoundingClientRect();
		if (!rect) return;
		const f = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
		const db = Math.round((EQ_MAX_DB - f * RANGE) / STEP) * STEP;
		if (db !== audioSettings.gains[i]) audioSettings.setBand(i, db);
	}

	function onpointerdown(i: number, e: PointerEvent) {
		if (!on) return;
		e.preventDefault();
		dragging = i;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		setFromPointer(i, e);
	}

	function onpointermove(i: number, e: PointerEvent) {
		if (dragging === i) setFromPointer(i, e);
	}

	function onkeydown(i: number, e: KeyboardEvent) {
		if (!on) return;
		const db = audioSettings.gains[i];
		const next =
			e.key === "ArrowUp" || e.key === "ArrowRight"
				? db + STEP
				: e.key === "ArrowDown" || e.key === "ArrowLeft"
					? db - STEP
					: e.key === "PageUp"
						? db + 3
						: e.key === "PageDown"
							? db - 3
							: e.key === "Home"
								? EQ_MAX_DB
								: e.key === "End"
									? EQ_MIN_DB
									: null;
		if (next === null) return;
		e.preventDefault();
		audioSettings.setBand(i, next);
	}

	// The response curve through the knobs, smoothed (Catmull-Rom → Bézier) in a
	// 1000×100 box that the SVG stretches over the sliders.
	const curve = $derived.by(() => {
		const pts = audioSettings.gains.map((db, i) => [
			((i + 0.5) / audioSettings.gains.length) * 1000,
			fraction(db) * 100,
		]);
		let d = `M0 ${pts[0][1]} L${pts[0][0]} ${pts[0][1]}`;
		for (let i = 0; i < pts.length - 1; i++) {
			const [p0, p1, p2, p3] = [
				pts[i - 1] ?? pts[i],
				pts[i],
				pts[i + 1],
				pts[i + 2] ?? pts[i + 1],
			];
			const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
			const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
			d += ` C${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${p2[0]} ${p2[1]}`;
		}
		const last = pts[pts.length - 1];
		return `${d} L1000 ${last[1]}`;
	});
</script>

<div class="page">
	<div class="head">
		<button
			class="back"
			onclick={() =>
				history.length > 1 ? history.back() : router.go("/profile")}
			><Icon name="chevronLeft" size={18} />Account</button
		>
	</div>
	<h1 class="page-title">Equalizer</h1>

	{#if !usable}
		<div class="notice">
			<Icon name="sliders" size={20} />
			<div>
				<strong>The equalizer needs Web Audio.</strong>
				<span
					>Turn it on in Account › Playback › Audio Engine, then restart
					hify.</span
				>
			</div>
		</div>
	{/if}

	<div class="group">
		<label class="row switch-row" class:disabled={!usable}>
			<span class="label">Equalizer</span>
			<input
				type="checkbox"
				class="switch"
				checked={audioSettings.eqEnabled}
				disabled={!usable}
				onchange={(e) => audioSettings.setEqEnabled(e.currentTarget.checked)}
			/>
		</label>
	</div>

	<div class="graphic" class:off={!on}>
		<div class="preset-name">
			{audioSettings.preset}
		</div>
		<div class="plot">
			<div class="scale" aria-hidden="true">
				<span>+12 dB</span>
				<span>0 dB</span>
				<span>−12 dB</span>
			</div>
			<div class="bands">
				<div class="grid" aria-hidden="true">
					<span></span><span class="zero"></span><span></span>
				</div>
				<svg
					class="curve"
					viewBox="0 0 1000 100"
					preserveAspectRatio="none"
					aria-hidden="true"
				>
					<path d={curve} vector-effect="non-scaling-stroke" />
				</svg>
				{#each audioSettings.gains as db, i (i)}
					<div
						class="band"
						role="slider"
						tabindex={on ? 0 : -1}
						aria-label={`${EQ_LABELS[i]} Hz`}
						aria-valuemin={EQ_MIN_DB}
						aria-valuemax={EQ_MAX_DB}
						aria-valuenow={db}
						aria-valuetext={formatDb(db)}
						aria-disabled={!on}
						onpointerdown={(e) => onpointerdown(i, e)}
						onpointermove={(e) => onpointermove(i, e)}
						onpointerup={() => (dragging = null)}
						onpointercancel={() => (dragging = null)}
						onkeydown={(e) => onkeydown(i, e)}
					>
						<div class="track" bind:this={tracks[i]}>
							<span class="knob" style:top="{fraction(db) * 100}%">
								{#if dragging === i}<span class="tip"
										>{formatDb(db)}</span
									>{/if}
							</span>
						</div>
						<span class="freq">{EQ_LABELS[i]}</span>
					</div>
				{/each}
			</div>
		</div>
	</div>

	<h3 class="group-title">Presets</h3>
	<div class="group presets" class:disabled={!usable}>
		{#if audioSettings.preset === "Custom"}
			<div class="row preset selected">
				<span class="label">Custom</span>
				<Icon name="check" size={18} />
			</div>
		{/if}
		{#each EQ_PRESET_NAMES as name (name)}
			{@const selected = audioSettings.eqEnabled && audioSettings.preset === name}
			<button
				class="row preset"
				class:selected
				disabled={!usable}
				onclick={() => audioSettings.setPreset(name)}
			>
				<span class="label">{name}</span>
				{#if selected}<Icon name="check" size={18} />{/if}
			</button>
		{/each}
	</div>
</div>

<style>
	.head {
		display: flex;
		align-items: center;
		padding: 0 var(--gutter);
		margin-bottom: 8px;
	}
	.back {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		color: var(--accent);
		font-size: 14px;
	}
	.notice {
		display: flex;
		gap: 12px;
		align-items: flex-start;
		margin: 0 var(--gutter) 20px;
		max-width: 720px;
		padding: 12px 14px;
		border-radius: 12px;
		background: color-mix(in srgb, var(--accent) 12%, transparent);
		color: var(--text);
		font-size: 13px;
	}
	.notice :global(svg) {
		flex-shrink: 0;
		color: var(--accent);
		margin-top: 1px;
	}
	.notice div {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.notice span {
		color: var(--text-2);
	}

	.group-title {
		margin: 0 var(--gutter) 8px;
		font-size: 13px;
		font-weight: 600;
		color: var(--text-2);
	}
	.group {
		margin: 0 var(--gutter) 26px;
		max-width: 720px;
		border-radius: 12px;
		background: var(--fill);
		overflow: hidden;
	}
	.group.disabled {
		opacity: 0.5;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 12px;
		width: 100%;
		min-height: 44px;
		padding: 0 14px;
		color: var(--text);
		text-align: left;
		font-size: 15px;
	}
	.row + .row {
		box-shadow: inset 0 0.5px 0 var(--hairline);
	}
	.label {
		flex: 1;
	}
	.switch-row {
		cursor: pointer;
	}
	.switch-row.disabled {
		opacity: 0.5;
		cursor: default;
	}

	/* iOS switch */
	.switch {
		appearance: none;
		position: relative;
		width: 51px;
		height: 31px;
		margin: 0;
		border-radius: 999px;
		background: var(--fill-strong);
		transition: background-color 0.2s ease;
		cursor: inherit;
		flex-shrink: 0;
	}
	.switch::after {
		content: "";
		position: absolute;
		top: 2px;
		left: 2px;
		width: 27px;
		height: 27px;
		border-radius: 50%;
		background: #fff;
		box-shadow: 0 2px 6px rgb(0 0 0 / 0.25);
		transition: transform 0.2s cubic-bezier(0.3, 0.7, 0.4, 1);
	}
	.switch:checked {
		background: #34c759;
	}
	.switch:checked::after {
		transform: translateX(20px);
	}

	/* ---- graphic EQ ------------------------------------------------------- */
	.graphic {
		margin: 0 var(--gutter) 26px;
		max-width: 720px;
		padding: 14px 14px 10px;
		border-radius: 12px;
		background: var(--fill);
		transition: opacity 0.2s ease;
	}
	.graphic.off {
		opacity: 0.45;
	}
	.preset-name {
		margin-bottom: 10px;
		font-size: 13px;
		font-weight: 600;
		color: var(--text-2);
		text-align: center;
	}
	.plot {
		display: flex;
		gap: 8px;
	}
	.scale {
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		height: 180px;
		font-size: 10px;
		color: var(--text-3);
		white-space: nowrap;
		text-align: right;
	}
	.scale span {
		line-height: 0;
	}
	.bands {
		position: relative;
		flex: 1;
		display: grid;
		grid-template-columns: repeat(10, 1fr);
	}
	.grid,
	.curve {
		position: absolute;
		inset: 0 0 auto;
		height: 180px;
		pointer-events: none;
	}
	.grid {
		display: flex;
		flex-direction: column;
		justify-content: space-between;
	}
	.grid span {
		height: 0;
		border-top: 0.5px dashed var(--hairline);
	}
	.grid .zero {
		border-top-style: solid;
	}
	.curve {
		width: 100%;
		overflow: visible;
	}
	.curve path {
		fill: none;
		stroke: var(--accent);
		stroke-width: 2;
		opacity: 0.55;
	}
	.band {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		touch-action: none;
		outline: none;
		cursor: ns-resize;
	}
	.graphic.off .band {
		cursor: default;
	}
	.track {
		position: relative;
		width: 4px;
		height: 180px;
		border-radius: 2px;
		background: var(--fill-strong);
	}
	.knob {
		position: absolute;
		left: 50%;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: #fff;
		box-shadow:
			0 1px 4px rgb(0 0 0 / 0.3),
			0 0 0 0.5px rgb(0 0 0 / 0.08);
		transform: translate(-50%, -50%);
	}
	.band:focus-visible .knob {
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 45%, transparent);
	}
	.tip {
		position: absolute;
		bottom: calc(100% + 8px);
		left: 50%;
		transform: translateX(-50%);
		padding: 3px 7px;
		border-radius: 6px;
		background: var(--text);
		color: var(--bg, #000);
		font-size: 11px;
		font-weight: 600;
		white-space: nowrap;
	}
	.freq {
		font-size: 10px;
		color: var(--text-2);
	}

	/* ---- presets ------------------------------------------------------------ */
	.preset :global(svg) {
		color: var(--accent);
	}
	.preset:disabled {
		cursor: default;
	}

	@media (max-width: 899px) {
		.page {
			padding-bottom: calc(108px + env(safe-area-inset-bottom));
		}
	}

	@media (max-width: 480px) {
		.scale {
			display: none;
		}
		.knob {
			width: 16px;
			height: 16px;
		}
	}
</style>
