import type { SourceType } from '$lib/player/types';

export const LyricsQueryKeyFactory = {
	// Version the key so old persisted "local has no lyrics" results cannot
	// suppress the on-demand local lyrics lookup after an application upgrade.
	prefix: ['lyrics', 'v2'] as const,
	lyrics: (
		userId: string | undefined,
		navidromeScope: string | undefined,
		sourceType: SourceType | undefined,
		trackSourceId: string | undefined,
		artistName: string | undefined,
		trackName: string | undefined,
		albumName?: string,
		duration?: number
	) =>
		[
			...LyricsQueryKeyFactory.prefix,
			userId,
			navidromeScope,
			sourceType,
			trackSourceId,
			artistName,
			trackName,
			albumName,
			duration
		] as const
};
