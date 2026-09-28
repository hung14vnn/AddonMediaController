// Thin wrapper over SvelteKit's hash router (see svelte.config.js). Routes live in
// src/routes; this keeps the small `router.route` / `router.go` / `href` API the
// components already use.
import { goto } from '$app/navigation';
import { page } from '$app/state';

export type Route =
	| { name: 'home' }
	| { name: 'browse' }
	| { name: 'search'; query: string }
	| { name: 'library' }
	| { name: 'profile' }
	| { name: 'recent' }
	| { name: 'artists' }
	| { name: 'albums' }
	| { name: 'songs' }
	| { name: 'playlists' }
	| { name: 'loved' }
	| { name: 'genres' }
	| { name: 'genre'; id: string }
	| { name: 'album'; id: string }
	| { name: 'artist'; id: string }
	| { name: 'playlist'; id: string };

// SvelteKit ignores `?…` inside the hash for matching, and `page.url` has the hash
// already decoded, so read the query from the raw location instead.
function hashQuery(): URLSearchParams {
	return new URLSearchParams(location.hash.split('?')[1] ?? '');
}

function current(): Route {
	// e.g. '/', '/album/[id]'; null when nothing matched (the error page).
	const head = page.route.id?.split('/')[1] ?? '';
	switch (head) {
		case '':
			return { name: 'home' };
		case 'search':
			return { name: 'search', query: hashQuery().get('q') ?? '' };
		case 'genre':
		case 'album':
		case 'artist':
		case 'playlist':
			return { name: head, id: page.params.id ?? '' };
		default:
			return { name: head } as Route;
	}
}

class Router {
	get route(): Route {
		void page.url; // re-run dependents on every navigation, including query-only changes
		return current();
	}

	go(path: string, replace = false) {
		return goto(`#${path}`, { replaceState: replace, keepFocus: true, noScroll: true });
	}
}

export const router = new Router();

export const href = {
	album: (id: string) => `#/album/${encodeURIComponent(id)}`,
	artist: (id: string) => `#/artist/${encodeURIComponent(id)}`,
	playlist: (id: string) => `#/playlist/${encodeURIComponent(id)}`,
	genre: (name: string) => `#/genre/${encodeURIComponent(name)}`,
	search: (query: string) => `#/search?q=${encodeURIComponent(query)}`
};
