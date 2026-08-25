import { describe, it, expect } from 'vitest';
import { formatArtistCredit, formatListenCount } from './formatting';

describe('formatArtistCredit', () => {
	it('renders semicolon-separated artist credits with commas', () => {
		expect.assertions(3);
		expect(formatArtistCredit('Artist A; Artist B')).toBe('Artist A, Artist B');
		expect(formatArtistCredit('Artist A ;  Artist B')).toBe('Artist A, Artist B');
		expect(formatArtistCredit(null)).toBe('');
	});
});

describe('formatListenCount', () => {
	it('returns empty string for null', () => {
		expect.assertions(1);
		expect(formatListenCount(null)).toBe('');
	});

	it('formats zero as "0 plays"', () => {
		expect.assertions(1);
		expect(formatListenCount(0)).toBe('0 plays');
	});

	it('formats zero compact as "0"', () => {
		expect.assertions(1);
		expect(formatListenCount(0, true)).toBe('0');
	});

	it('formats small number with suffix', () => {
		expect.assertions(1);
		expect(formatListenCount(42)).toBe('42 plays');
	});

	it('formats thousands', () => {
		expect.assertions(1);
		expect(formatListenCount(1500)).toBe('1.5K plays');
	});

	it('formats thousands compact', () => {
		expect.assertions(1);
		expect(formatListenCount(1500, true)).toBe('1.5K');
	});

	it('formats millions', () => {
		expect.assertions(1);
		expect(formatListenCount(2500000)).toBe('2.5M plays');
	});

	it('formats millions compact', () => {
		expect.assertions(1);
		expect(formatListenCount(2500000, true)).toBe('2.5M');
	});

	it('formats billions', () => {
		expect.assertions(1);
		expect(formatListenCount(3596400000)).toBe('3.6B plays');
	});

	it('formats billions compact', () => {
		expect.assertions(1);
		expect(formatListenCount(3596400000, true)).toBe('3.6B');
	});
});
