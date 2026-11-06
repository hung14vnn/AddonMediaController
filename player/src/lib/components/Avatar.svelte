<script lang="ts">
	// Round user avatar: the server's getAvatar image, else initials on a solid Google button blue disc.
	import { avatarUrl } from '../api';

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

<span class="avatar" style:--size="{size}px">
	{#if src && !failed}
		<img {src} alt="" onerror={() => (failed = true)} oncontextmenu={(e) => e.preventDefault()} />
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
		background: #165548;
		box-shadow: inset 0 0 0 0.5px rgba(255, 255, 255, 0.12);
	}
	img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.initials {
		color: #fff;
		font-weight: 500;
		font-size: calc(var(--size) * 0.44);
		letter-spacing: 0.01em;
		user-select: none;
	}
</style>
