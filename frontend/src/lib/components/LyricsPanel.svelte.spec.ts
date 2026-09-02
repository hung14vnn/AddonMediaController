import { page } from '@vitest/browser/context';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';

import LyricsPanel from './LyricsPanel.svelte';

describe('LyricsPanel', () => {
	it('highlights the synchronized line at the current playback time', async () => {
		render(LyricsPanel, {
			open: true,
			lyricsText: 'First line\nSecond line\nThird line',
			lines: [
				{ text: 'First line', start_seconds: 0 },
				{ text: 'Second line', start_seconds: 5 },
				{ text: 'Third line', start_seconds: 10 }
			],
			isSynced: true,
			currentTime: 7,
			preferWordSynced: false,
			onclose: vi.fn()
		});

		await expect.element(page.getByText('Second line', { exact: true })).toHaveClass(/text-accent/);
		await expect.element(page.getByText('First line', { exact: true })).toHaveClass(/opacity-45/);
		await expect.element(page.getByText('Third line', { exact: true })).toHaveClass(/opacity-30/);
		await expect.element(page.getByText('Synced', { exact: true })).not.toBeInTheDocument();
	});

	it('renders plain lyrics when no timed lines are available', async () => {
		render(LyricsPanel, {
			open: true,
			lyricsText: 'Plain first line\nPlain second line',
			lines: [
				{ text: 'Plain first line', start_seconds: null },
				{ text: 'Plain second line', start_seconds: null }
			],
			isSynced: false,
			preferWordSynced: false,
			onclose: vi.fn()
		});

		await expect.element(page.getByText(/Plain first line/)).toBeVisible();
		await expect.element(page.getByText('Synced', { exact: true })).not.toBeInTheDocument();
	});

	it('hides the outer page scrollbar only while the full-screen panel is open', async () => {
		const props = {
			open: true,
			lyricsText: 'Plain lyrics',
			preferWordSynced: false,
			onclose: vi.fn()
		};
		const view = render(LyricsPanel, props);

		await expect
			.poll(() => document.documentElement.classList.contains('lyrics-page-scroll-lock'))
			.toBe(true);
		expect(document.body).toHaveClass('lyrics-page-scroll-lock');
		expect(getComputedStyle(document.documentElement).overflow).toBe('hidden');
		expect(getComputedStyle(document.body).overflow).toBe('hidden');

		await view.rerender({ ...props, open: false });

		await expect
			.poll(() => document.documentElement.classList.contains('lyrics-page-scroll-lock'))
			.toBe(false);
		expect(document.body).not.toHaveClass('lyrics-page-scroll-lock');
	});
});
