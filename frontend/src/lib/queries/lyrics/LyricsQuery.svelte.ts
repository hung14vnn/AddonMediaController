import { api, ApiError } from '$lib/api/client';
import { API, CACHE_TTL } from '$lib/constants';
import type { LyricLine, LyricsResponse } from '$lib/types';
import type { NowPlaying } from '$lib/player/types';
import { createQuery } from '@tanstack/svelte-query';
import type { Getter } from 'runed';
import { normalizeWordTimedLyrics } from '$lib/utils/lyrics';
import { LyricsQueryKeyFactory } from './LyricsQueryKeyFactory';

export interface LyricsData {
	text: string;
	is_synced: boolean;
	lines: LyricLine[];
	source?: string;
}

export async function fetchLyrics(np: NowPlaying, signal: AbortSignal): Promise<LyricsData | null> {
	try {
		if (
			np.sourceType === 'navidrome' ||
			np.sourceType === 'jellyfin' ||
			np.sourceType === 'local'
		) {
			const url = API.lyrics(
				np.sourceType,
				np.trackSourceId!,
				np.artistName,
				np.trackName ?? '',
				np.albumName,
				np.duration
			);
			const data = await api.global.get<LyricsResponse>(url, { signal });
			const normalized = normalizeWordTimedLyrics(
				data.text ?? '',
				data.lines ?? [],
				data.is_synced ?? false
			);
			return {
				text: data.text ?? '',
				is_synced: normalized.is_synced,
				lines: normalized.lines,
				source: data.source ?? ''
			};
		}
		return null;
	} catch (e) {
		if (e instanceof ApiError && e.status === 404) return null;
		throw e;
	}
}

export const getLyricsQuery = (
	getNowPlaying: Getter<NowPlaying | null>,
	getUserId: Getter<string | undefined>,
	getNavidromeScope: Getter<string | undefined>,
	getEnabled: Getter<boolean> = () => true
) =>
	createQuery(() => {
		const np = getNowPlaying();
		return {
			// Cache actual lyric data for an hour, but never cache a miss as fresh.
			// A later play can then discover newly available provider lyrics or a
			// sidecar added after import.
			staleTime: (query) => (query.state.data === null ? 0 : CACHE_TTL.LYRICS),
			gcTime: CACHE_TTL.LYRICS,
			queryKey: LyricsQueryKeyFactory.lyrics(
				getUserId(),
				np?.sourceType === 'navidrome' ? getNavidromeScope() : undefined,
				np?.sourceType,
				np?.trackSourceId,
				np?.artistName,
				np?.trackName,
				np?.albumName,
				np?.duration
			),
			queryFn: ({ signal }: { signal: AbortSignal }) => fetchLyrics(np!, signal),
			enabled:
				getEnabled() &&
				!!np?.trackSourceId &&
				(np.sourceType === 'navidrome' || np.sourceType === 'jellyfin' || np.sourceType === 'local')
		};
	});
