// Tiny hash router: hash routing works from any sub-path and needs no server rewrites,
// which keeps the PWA deployable as plain static files.

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

function parse(hash: string): Route {
	const [path, qs = ''] = hash.replace(/^#/, '').split('?');
	const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
	const [head, id] = parts;
	switch (head) {
		case 'browse':
			return { name: 'browse' };
		case 'search':
			return { name: 'search', query: new URLSearchParams(qs).get('q') ?? '' };
		case 'library':
		case 'profile':
		case 'recent':
		case 'artists':
		case 'albums':
		case 'songs':
		case 'playlists':
		case 'loved':
		case 'genres':
			return { name: head };
		case 'genre':
		case 'album':
		case 'artist':
		case 'playlist':
			if (id) return { name: head, id };
			break;
	}
	return { name: 'home' };
}

class Router {
	route = $state<Route>(parse(location.hash));

	constructor() {
		addEventListener('hashchange', () => {
			this.route = parse(location.hash);
		});
	}

	go(path: string, replace = false) {
		const hash = `#${path}`;
		if (replace) history.replaceState(null, '', hash);
		else if (location.hash !== hash) location.hash = hash;
		this.route = parse(hash);
	}
}

export const router = new Router();

export const href = {
	album: (id: string) => `#/album/${encodeURIComponent(id)}`,
	artist: (id: string) => `#/artist/${encodeURIComponent(id)}`,
	playlist: (id: string) => `#/playlist/${encodeURIComponent(id)}`,
	genre: (name: string) => `#/genre/${encodeURIComponent(name)}`
};
