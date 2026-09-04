import { describe, expect, it } from 'vitest';
import { dismissTopBackOverlay, registerBackDismiss } from './backDismissStack.svelte';

describe('back dismiss stack', () => {
	it('dismisses overlays in reverse opening order', () => {
		const dismissed: string[] = [];
		registerBackDismiss(() => dismissed.push('first'));
		registerBackDismiss(() => dismissed.push('second'));

		expect(dismissTopBackOverlay()).toBe(true);
		expect(dismissTopBackOverlay()).toBe(true);
		expect(dismissTopBackOverlay()).toBe(false);
		expect(dismissed).toEqual(['second', 'first']);
	});

	it('removes an overlay when it closes normally', () => {
		const cleanup = registerBackDismiss(() => {});
		cleanup();

		expect(dismissTopBackOverlay()).toBe(false);
	});
});
