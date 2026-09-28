import { clearSession, getSession } from './api';
import { getPlayer } from './player.svelte';
import { router } from './router.svelte';
import { ui } from './ui.svelte';

class Auth {
	signedIn = $state(!!getSession());

	signOut() {
		getPlayer().reset();
		clearSession();
		ui.nowPlaying = false;
		ui.me = null;
		ui.playlists = [];
		this.signedIn = false;
		router.go('/', true);
	}
}

export const auth = new Auth();
