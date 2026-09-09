export const MOBILE_LOW_POWER_CLASS = 'mobile-low-power-playback';

/**
 * Identify Apple mobile browsers, including iPadOS versions that advertise a
 * desktop Macintosh user agent. This is kept separate from the broader mobile
 * visual policy because some playback workarounds are specific to WebKit.
 */
export function isIosDevice(): boolean {
	if (typeof navigator === 'undefined') return false;

	const userAgent = navigator.userAgent ?? '';
	return (
		/iPhone|iPad|iPod/i.test(userAgent) ||
		(/Macintosh/i.test(userAgent) && navigator.maxTouchPoints > 1)
	);
}

/** Identify mobile devices, including tablets using a desktop browser mode. */
export function isMobileDevice(): boolean {
	if (typeof navigator === 'undefined') return false;

	const userAgentData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } })
		.userAgentData;
	if (userAgentData?.mobile === true) return true;
	if (isIosDevice() || /Android|Mobile/i.test(navigator.userAgent)) return true;

	return (
		navigator.maxTouchPoints > 0 &&
		typeof window !== 'undefined' &&
		typeof window.matchMedia === 'function' &&
		window.matchMedia('(pointer: coarse)').matches
	);
}

/**
 * Identify phones and tablets without relying on viewport width. A narrow desktop
 * window should keep the full visual treatment, while installed mobile PWAs and
 * tablets should avoid effects that continuously composite large blurred layers.
 */
export function usesMobileLowPowerVisuals(): boolean {
	if (isMobileDevice()) return true;

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
