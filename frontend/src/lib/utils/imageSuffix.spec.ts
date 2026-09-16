import { describe, it, expect } from 'vitest';
import { appendAudioDBSizeSuffix } from './imageSuffix';

describe('appendAudioDBSizeSuffix', () => {
	const baseUrl = 'https://r2.theaudiodb.com/images/media/artist/thumb/abc123.jpg';

	it('appends /small for xs size', () => {
		expect.assertions(1);
		expect(appendAudioDBSizeSuffix(baseUrl, 'xs')).toBe(`${baseUrl}/small`);
	});

	it('appends /small for sm size', () => {
		expect.assertions(1);
		expect(appendAudioDBSizeSuffix(baseUrl, 'sm')).toBe(`${baseUrl}/small`);
	});

	it('appends /small for md size', () => {
		expect.assertions(1);
		expect(appendAudioDBSizeSuffix(baseUrl, 'md')).toBe(`${baseUrl}/small`);
	});

	it('appends /medium for lg size', () => {
		expect.assertions(1);
		expect(appendAudioDBSizeSuffix(baseUrl, 'lg')).toBe(`${baseUrl}/medium`);
	});

	it('appends /medium for xl size', () => {
		expect.assertions(1);
		expect(appendAudioDBSizeSuffix(baseUrl, 'xl')).toBe(`${baseUrl}/medium`);
	});

	it('appends /medium for hero size', () => {
		expect.assertions(1);
		expect(appendAudioDBSizeSuffix(baseUrl, 'hero')).toBe(`${baseUrl}/medium`);
	});

	it('returns original URL for full size', () => {
		expect.assertions(1);
		expect(appendAudioDBSizeSuffix(baseUrl, 'full')).toBe(baseUrl);
	});

	it('is idempotent when URL already ends with /small', () => {
		expect.assertions(1);
		const urlWithSuffix = `${baseUrl}/small`;
		expect(appendAudioDBSizeSuffix(urlWithSuffix, 'md')).toBe(urlWithSuffix);
	});

	it('is idempotent when URL already ends with /medium', () => {
		expect.assertions(1);
		const urlWithSuffix = `${baseUrl}/medium`;
		expect(appendAudioDBSizeSuffix(urlWithSuffix, 'lg')).toBe(urlWithSuffix);
	});

	it('handles empty string input gracefully', () => {
		expect.assertions(2);
		expect(appendAudioDBSizeSuffix('', 'md')).toBe('');
		expect(appendAudioDBSizeSuffix('', 'full')).toBe('');
	});
});
