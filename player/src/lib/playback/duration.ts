/** Browser-reported length this much longer than the server's means the browser misread it. */
export const DURATION_MISMATCH_RATIO = 1.25;

export interface ResolvedDuration {
	/** Length to show and report to the lock screen. */
	duration: number;
	/**
	 * Server length that playback should end at, or 0 for none. Undefined leaves the
	 * current cap unchanged (the media element has no usable duration yet).
	 */
	cap?: number;
}

/**
 * Pick the track length to trust. iOS Safari misjudges fragmented (DASH) m4a such as
 * YouTube Music streams, often at about double, then plays silence up to that length
 * before `ended` fires; the server's length wins when the two disagree that much.
 */
export function resolveDuration(media: number, reported: number, previous: number): ResolvedDuration {
	if (!Number.isFinite(media)) return { duration: previous || reported };
	if (reported > 0 && media > reported * DURATION_MISMATCH_RATIO) {
		return { duration: reported, cap: reported };
	}
	return { duration: media, cap: 0 };
}
