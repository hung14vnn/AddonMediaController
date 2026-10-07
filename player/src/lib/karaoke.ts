// The karaoke button's action, shared by the lyrics view (desktop) and the Now
// Playing header (phones).
import { getPlayer } from './player.svelte';
import { ui } from './ui.svelte';

export async function toggleKaraoke() {
	const problem = await getPlayer().toggleKaraoke();
	if (problem) ui.showToast(problem);
}
