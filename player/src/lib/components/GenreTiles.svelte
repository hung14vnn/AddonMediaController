<script lang="ts">
	import { hue } from '../format';
	import { href } from '../router.svelte';
	import type { Genre } from '../types';

	let { genres }: { genres: Genre[] } = $props();
</script>

<div class="tiles">
	{#each genres as genre (genre.value)}
		<a class="tile" href={href.genre(genre.value)} style:--h={hue(genre.value)}>
			<span>{genre.value}</span>
		</a>
	{/each}
</div>

<style>
	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
		gap: 16px;
		padding: 0 var(--gutter);
	}
	@media (max-width: 699px) {
		.tiles {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 12px;
		}
	}
	.tile {
		position: relative;
		aspect-ratio: 16 / 10;
		border-radius: 10px;
		overflow: hidden;
		display: flex;
		align-items: flex-end;
		padding: 12px 14px;
		color: #fff;
		font-size: 16px;
		font-weight: 700;
		letter-spacing: -0.01em;
		background: linear-gradient(135deg, hsl(var(--h) 70% 55%), hsl(calc(var(--h) + 40) 65% 38%));
		transition: transform 0.15s ease;
	}
	.tile::after {
		content: '';
		position: absolute;
		right: -18%;
		top: -30%;
		width: 60%;
		aspect-ratio: 1;
		border-radius: 50%;
		background: rgb(255 255 255 / 0.14);
	}
	.tile:hover {
		transform: translateY(-2px);
	}
	.tile span {
		position: relative;
		z-index: 1;
		text-shadow: 0 1px 8px rgb(0 0 0 / 0.2);
	}
</style>
