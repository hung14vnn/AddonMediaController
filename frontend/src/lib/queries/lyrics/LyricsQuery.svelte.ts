import { api, ApiError } from '$lib/api/client';
import { API, CACHE_TTL } from '$lib/constants';
import type { LyricLine, LyricsResponse } from '$lib/types';
import type { NowPlaying } from '$lib/player/types';
import { createQuery } from '@tanstack/svelte-query';
import type { Getter } from 'runed';
import { LyricsQueryKeyFactory } from './LyricsQueryKeyFactory';

export interface LyricsData {
	text: string;
	is_synced: boolean;
	lines: LyricLine[];
	source?: string;
}

export async function fetchLyrics(np: NowPlaying, signal: AbortSignal): Promise<LyricsData | null> {
	try {
		if (np.sourceType === 'navidrome' || np.sourceType === 'jellyfin' || np.sourceType === 'local') {
			const url = API.lyrics(np.sourceType, np.trackSourceId!, np.artistName, np.trackName ?? '', np.albumName, np.duration);
			const data = await api.global.get<LyricsResponse>(url, { signal });
			return { text: data.text ?? '', is_synced: data.is_synced ?? false, lines: data.lines ?? [], source: data.source ?? '' };
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
	getNavidromeScope: Getter<string | undefined>
) =>
	createQuery(() => {
		const np = getNowPlaying();
		return {
			staleTime: CACHE_TTL.LYRICS,
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
				!!np?.trackSourceId && (np.sourceType === 'navidrome' || np.sourceType === 'jellyfin' || np.sourceType === 'local')
		};
	});
