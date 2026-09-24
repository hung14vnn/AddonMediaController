<script lang="ts">
	// Round user avatar: the server's getAvatar image, else initials on a tinted disc.
	import { avatarUrl } from '../api';
	import { hue } from '../format';

	let { username, size = 32 }: { username?: string; size?: number } = $props();

	let failed = $state(false);
	const src = $derived(username ? avatarUrl(username) : undefined);
	const initials = $derived(
		(username ?? '?')
			.split(/[\s._-]+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((w) => w[0].toUpperCase())
			.join('') || '?'
	);

	$effect(() => {
		void src;
		failed = false;
	});
</script>

<span class="avatar" style:--size="{size}px" style:--h={hue(username ?? '')}>
	{#if src && !failed}
		<img {src} alt="" onerror={() => (failed = true)} />
	{:else}
		<span class="initials" aria-hidden="true">{initials}</span>
	{/if}
</span>

<style>
	.avatar {
		width: var(--size);
		height: var(--size);
		flex-shrink: 0;
		border-radius: 50%;
		overflow: hidden;
		display: grid;
		place-items: center;
		background: linear-gradient(145deg, hsl(var(--h) 45% 62%), hsl(calc(var(--h) + 30) 45% 45%));
		box-shadow: inset 0 0 0 0.5px var(--hairline);
	}
	img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.initials {
		color: #fff;
		font-weight: 600;
		font-size: calc(var(--size) * 0.4);
		letter-spacing: 0.02em;
	}
</style>
