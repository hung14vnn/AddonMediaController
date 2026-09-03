import type { PlaybackSource, SourceType } from './types';
import { YouTubePlaybackSource } from './YouTubePlaybackSource';
import { NativeAudioSource } from './NativeAudioSource';
import { YOUTUBE_PLAYER_ELEMENT_ID } from '$lib/constants';
import { getApiUrl } from '$lib/api/api-utils';

export type NativeSourceOptions = {
	url: string;
	seekable: boolean;
	cleanup?: () => void;
};

export function createPlaybackSource(type: SourceType, opts?: NativeSourceOptions): PlaybackSource {
	const nativeOptions = opts ? { ...opts, url: getApiUrl(opts.url) } : undefined;
	switch (type) {
		case 'youtube':
			return new YouTubePlaybackSource(YOUTUBE_PLAYER_ELEMENT_ID);
		case 'jellyfin':
			if (!opts) throw new Error('Jellyfin playback source requires url and seekable options');
			return new NativeAudioSource('jellyfin', nativeOptions!);
		case 'local':
			if (!opts) throw new Error('Local playback source requires url and seekable options');
			return new NativeAudioSource('local', nativeOptions!);
		case 'navidrome':
			if (!opts) throw new Error('Navidrome playback source requires url and seekable options');
			return new NativeAudioSource('navidrome', nativeOptions!);
		case 'plex':
			if (!opts) throw new Error('Plex playback source requires url and seekable options');
			return new NativeAudioSource('plex', nativeOptions!);
		default: {
			const _exhaustive: never = type;
			throw new Error(`Unknown source type: ${_exhaustive}`);
		}
	}
}
