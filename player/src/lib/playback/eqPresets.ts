// Ten-band graphic EQ, the bands Apple Music's equalizer uses. Preset names
// follow Apple Music (Settings › Music › EQ); curves approximate its presets.

export const EQ_FREQUENCIES = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;
export const EQ_LABELS = ['32', '64', '125', '250', '500', '1K', '2K', '4K', '8K', '16K'] as const;
export const EQ_BAND_COUNT = EQ_FREQUENCIES.length;
export const EQ_MIN_DB = -12;
export const EQ_MAX_DB = 12;

export const EQ_PRESETS = {
	Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
	Acoustic: [5, 5, 4, 1, 1.5, 1.5, 3.5, 4, 3.5, 2],
	'Bass Booster': [5.5, 4.5, 3.5, 2.5, 1, 0, 0, 0, 0, 0],
	'Bass Reducer': [-5.5, -4.5, -3.5, -2.5, -1, 0, 0, 0, 0, 0],
	Classical: [4.5, 3.5, 3, 2.5, -1.5, -1.5, 0, 2, 3, 3.5],
	Dance: [3.5, 6.5, 5, 0, 2, 3.5, 5, 4.5, 3.5, 0],
	Deep: [5, 3.5, 1.5, 1, 3, 2.5, 1.5, -2, -3.5, -4.5],
	Electronic: [4, 3.5, 1, 0, -2, 2, 1, 1, 4, 4.5],
	'Hip-Hop': [5, 4, 1.5, 3, -1, -1, 1.5, -0.5, 2, 3],
	Jazz: [4, 3, 1.5, 2, -1.5, -1.5, 0, 1.5, 3, 3.5],
	'Late Night': [4.5, 3, 0, -1, -1, 0, 1, 2, 3, 4],
	Lounge: [-3, -1.5, -0.5, 1.5, 4, 2.5, 0, -1.5, 2, 1],
	Piano: [3, 2, 0, 2.5, 3, 1.5, 3.5, 4.5, 3, 3.5],
	Pop: [-1.5, -1, 0, 2, 4, 4, 2, 0, -1, -1.5],
	'R&B': [2.5, 7, 5.5, 1.5, -2, -1.5, 2.5, 2.5, 3, 3.5],
	Rock: [5, 4, 3, 1.5, -0.5, -1, 0.5, 2.5, 3.5, 4.5],
	'Small Speakers': [5.5, 4.5, 3.5, 2.5, 1, 0, -1, -2.5, -3.5, -4.5],
	'Treble Booster': [0, 0, 0, 0, 0, 1, 2.5, 3.5, 4.5, 5.5],
	'Treble Reducer': [0, 0, 0, 0, 0, -1, -2.5, -3.5, -4.5, -5.5],
	'Vocal Booster': [-1.5, -3, -3, 1.5, 3.5, 3.5, 3, 1.5, 0, -1.5]
} as const satisfies Record<string, readonly number[]>;

export type EqPresetName = keyof typeof EQ_PRESETS;
export const EQ_PRESET_NAMES = Object.keys(EQ_PRESETS) as EqPresetName[];

export function clampDb(db: number): number {
	return Math.max(EQ_MIN_DB, Math.min(EQ_MAX_DB, Number.isFinite(db) ? db : 0));
}
