import { resolve } from '$app/paths';

export function albumHref(id: string): string {
	if (!id) return '#';
	return resolve('/album/[id]', { id });
}

export function artistHref(id: string): string {
	return resolve('/artist/[id]', { id });
}

/** Opens the provider profile even when this artist is also in the local library. */
export function providerArtistHref(id: string): string {
	return `${artistHref(id)}?source=provider`;
}

export function localAlbumHref(id: string): string {
	return albumHref(id);
}

export function localArtistHref(id: string): string {
	return artistHref(id);
}

export function albumHrefOrNull(id: string | null | undefined): string | null {
	// Spotify fallback IDs are internal import metadata, not provider album IDs.
	// A local catalog card must use its `local_id` UUID instead.
	return id && !id.startsWith('spotify:album:') ? albumHref(id) : null;
}

export function artistHrefOrNull(id: string | null | undefined): string | null {
	return id ? artistHref(id) : null;
}
