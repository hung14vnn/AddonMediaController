import { describe, expect, it } from 'vitest';
import { resolveDuration } from './duration';

describe('resolveDuration', () => {
	it('trusts the media element when it agrees with the server', () => {
		expect(resolveDuration(241.3, 240, 240)).toEqual({ duration: 241.3, cap: 0 });
	});

	it('caps at the server length when the browser reports about double (iOS DASH m4a)', () => {
		expect(resolveDuration(480, 240, 240)).toEqual({ duration: 240, cap: 240 });
	});

	it('uses the media length when the server has none', () => {
		expect(resolveDuration(480, 0, 0)).toEqual({ duration: 480, cap: 0 });
	});

	it('leaves the cap alone while the element has no duration yet', () => {
		expect(resolveDuration(NaN, 240, 0)).toEqual({ duration: 240 });
		expect(resolveDuration(Infinity, 240, 100)).toEqual({ duration: 100 });
	});
});
