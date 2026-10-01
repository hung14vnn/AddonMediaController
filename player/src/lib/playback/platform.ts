/** iPadOS reports a Mac user agent; touch support tells them apart. */
export const isIOS =
	typeof navigator !== 'undefined' &&
	(/iphone|ipad|ipod/i.test(navigator.userAgent) ||
		(/mac/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1));

/** Launched from the home screen (installed PWA) rather than a browser tab. */
export function isStandalone() {
	return (
		window.matchMedia?.('(display-mode: standalone)').matches ||
		(navigator as Navigator & { standalone?: boolean }).standalone === true
	);
}
