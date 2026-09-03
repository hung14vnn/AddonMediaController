export const MOBILE_LOW_POWER_CLASS = 'mobile-low-power-playback';

/**
 * Identify phones and tablets without relying on viewport width. A narrow desktop
 * window should keep the full visual treatment, while installed mobile PWAs and
 * tablets should avoid effects that continuously composite large blurred layers.
 */
export function usesMobileLowPowerVisuals(): boolean {
	if (typeof navigator === 'undefined') return false;

	if (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) return true;
	if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) return true;

	return (
		typeof window !== 'undefined' &&
		typeof window.matchMedia === 'function' &&
		window.matchMedia('(hover: none) and (pointer: coarse)').matches
	);
}

/** Install the mobile-only visual policy and return its cleanup function. */
export function installMobileLowPowerVisuals(root?: HTMLElement): () => void {
	const target = root ?? (typeof document !== 'undefined' ? document.documentElement : null);
	if (!target) return () => {};
	if (!usesMobileLowPowerVisuals()) {
		target.classList.remove(MOBILE_LOW_POWER_CLASS);
		return () => {};
	}

	target.classList.add(MOBILE_LOW_POWER_CLASS);
	return () => target.classList.remove(MOBILE_LOW_POWER_CLASS);
}
