// Ten-band graphic EQ, the bands Apple Music's equalizer uses. Preset names
// follow Apple Music (Settings › Music › EQ); curves approximate its presets.

export const EQ_FREQUENCIES = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;
export const EQ_LABELS = ['32', '64', '125', '250', '500', '1K', '2K', '4K', '8K', '16K'] as const;
export const EQ_BAND_COUNT = EQ_FREQUENCIES.length;
export const EQ_MIN_DB = -12;
export const EQ_MAX_DB = 12;

export const EQ_PRESETS = {
	Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
	Rock: [5, 4, 3, 1, -1, 1, 3, 4, 5, 5],
	Pop: [-1, 1, 3, 4, 3, 0, -1, -1, 2, 3],
	Jazz: [3, 2, 1, 2, -1, -1, 0, 1, 3, 4],
	Classical: [4, 3, 2, 1, -1, -1, 0, 2, 3, 4],
	'Bass Boost': [8, 6, 4, 2, 0, 0, 0, 0, 0, 0],
	'Treble Boost': [0, 0, 0, 0, 0, 0, 2, 4, 6, 8],
	Vocal: [-2, -1, 0, 2, 4, 4, 3, 1, 0, -1],
	Electronic: [5, 4, 2, 0, -2, 1, 3, 4, 5, 4],
	Acoustic: [3, 2, 1, 1, 0, 0, 1, 2, 3, 2]
} as const satisfies Record<string, readonly number[]>;

export type EqPresetName = keyof typeof EQ_PRESETS;
export const EQ_PRESET_NAMES = Object.keys(EQ_PRESETS) as EqPresetName[];

export function clampDb(db: number): number {
	return Math.max(EQ_MIN_DB, Math.min(EQ_MAX_DB, Number.isFinite(db) ? db : 0));
}
