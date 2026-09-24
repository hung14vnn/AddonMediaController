<script lang="ts">
	// Avatar shortcut to the Account page in mobile page headers (iOS Music style).
	// Hidden on desktop, where the sidebar footer links there instead.
	import { getSession } from '../api';
	import { ui } from '../ui.svelte';
	import Avatar from './Avatar.svelte';

	const session = getSession();
</script>

<a class="profile-btn" href="#/profile" aria-label="Account">
	<Avatar username={ui.me?.username ?? session?.username} size={34} />
</a>

<style>
	.profile-btn {
		display: none;
		border-radius: 50%;
		transition: transform 0.18s cubic-bezier(0.3, 1.3, 0.5, 1);
	}
	.profile-btn:active {
		transform: scale(0.9);
	}
	@media (max-width: 899px) {
		.profile-btn {
			display: block;
		}
	}
</style>
