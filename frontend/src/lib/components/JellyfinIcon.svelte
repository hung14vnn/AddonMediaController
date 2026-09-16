<script lang="ts">
	import type { SVGAttributes } from 'svelte/elements';

	interface Props extends SVGAttributes<SVGSVGElement> {
		class?: string;
	}

	let { class: className = 'h-6 w-6', ...restProps }: Props = $props();
</script>

<svg
	xmlns="http://www.w3.org/2000/svg"
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="2"
	stroke-linecap="round"
	stroke-linejoin="round"
	class={className}
	aria-hidden="true"
	{...restProps}
>
	<rect x="2" y="7" width="20" height="15" rx="2" ry="2"></rect>
	<polyline points="17 2 12 7 7 2"></polyline>
</svg>
