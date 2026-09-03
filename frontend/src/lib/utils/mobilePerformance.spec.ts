import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	installMobileLowPowerVisuals,
	MOBILE_LOW_POWER_CLASS,
	usesMobileLowPowerVisuals
} from './mobilePerformance';

describe('mobile low-power visuals', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('recognizes Android and iOS user agents', () => {
		vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9)' });
		expect(usesMobileLowPowerVisuals()).toBe(true);

		vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)' });
		expect(usesMobileLowPowerVisuals()).toBe(true);
	});

	it('recognizes touch-first tablets with desktop user agents', () => {
		vi.stubGlobal('navigator', {
			userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)',
			platform: 'MacIntel',
			maxTouchPoints: 5
		});
		vi.stubGlobal('window', {
			matchMedia: vi.fn(() => ({ matches: false }))
		});

		expect(usesMobileLowPowerVisuals()).toBe(true);
	});

	it('recognizes other touch-first mobile devices through pointer capabilities', () => {
		vi.stubGlobal('navigator', {
			userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
			platform: 'Linux',
			maxTouchPoints: 1
		});
		vi.stubGlobal('window', {
			matchMedia: vi.fn(() => ({ matches: true }))
		});

		expect(usesMobileLowPowerVisuals()).toBe(true);
	});

	it('does not classify a narrow-capable desktop by user agent alone', () => {
		vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' });
		vi.stubGlobal('window', {
			matchMedia: vi.fn(() => ({ matches: false }))
		});

		expect(usesMobileLowPowerVisuals()).toBe(false);
	});

	it('installs and cleans up the root class', () => {
		vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Linux; Android 15; Mobile)' });
		const classes = new Set<string>();
		const root = {
			classList: {
				add: (name: string) => classes.add(name),
				remove: (name: string) => classes.delete(name)
			}
		} as unknown as HTMLElement;
		const cleanup = installMobileLowPowerVisuals(root);

		expect(classes.has(MOBILE_LOW_POWER_CLASS)).toBe(true);
		cleanup();
		expect(classes.has(MOBILE_LOW_POWER_CLASS)).toBe(false);
	});
});
