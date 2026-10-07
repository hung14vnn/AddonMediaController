// ReplayGain (Settings › Playback › Sound Check): plays every song at about the same
// loudness, from the gain the library computed for its file. Album gain keeps an
// album's own quiet and loud songs as mastered; track gain evens out a mix.
import type { Song } from '../types';

export type GainMode = 'track' | 'album';

/**
 * Album gain while an album plays in order (a neighbour in the queue is from the same
 * album), track gain otherwise.
 */
export function gainModeFor(queue: readonly Song[], index: number, shuffle: boolean): GainMode {
	const albumId = queue[index]?.albumId;
	if (shuffle || !albumId) return 'track';
	return queue[index - 1]?.albumId === albumId || queue[index + 1]?.albumId === albumId ? 'album' : 'track';
}

/**
 * Linear gain for `song`, lowered when needed so its peak stays below full scale.
 * 1 when the file has no ReplayGain (streams from YouTube/Spotify, untagged files).
 */
export function replayGainFactor(song: Song | null | undefined, mode: GainMode): number {
	const rg = song?.replayGain;
	if (!rg) return 1;
	const db = (mode === 'album' ? rg.albumGain : rg.trackGain) ?? rg.trackGain ?? rg.albumGain;
	if (typeof db !== 'number' || !Number.isFinite(db)) return 1;
	const peak = (mode === 'album' ? rg.albumPeak : rg.trackPeak) ?? rg.trackPeak ?? rg.albumPeak;
	const gain = 10 ** (db / 20);
	return typeof peak === 'number' && peak > 0 ? Math.min(gain, 1 / peak) : gain;
}
