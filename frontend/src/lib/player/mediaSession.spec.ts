import { afterEach, describe, expect, it, vi } from 'vitest';
import { setMediaSessionActionHandler, updateMediaSessionMetadata } from './mediaSession';

describe('updateMediaSessionMetadata', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('sets the current song details and cover art for system media controls', () => {
		const mediaSession = { metadata: null as unknown };
		class FakeMediaMetadata {
			constructor(init: unknown) {
				Object.assign(this, init);
			}
		}
		vi.stubGlobal('navigator', { mediaSession });
		vi.stubGlobal('window', { location: { origin: 'https://addonify.test' } });
		vi.stubGlobal('MediaMetadata', FakeMediaMetadata);

		updateMediaSessionMetadata({
			trackName: 'Ticket to Ride',
			artistName: 'KAWALA',
			albumName: 'Ticket to Ride',
			coverUrl: '/api/v1/covers/ticket-to-ride'
		});

		expect(mediaSession.metadata).toMatchObject({
			title: 'Ticket to Ride',
			artist: 'KAWALA',
			album: 'Ticket to Ride',
			artwork: [{ src: 'https://addonify.test/api/v1/covers/ticket-to-ride' }]
		});
	});

	it('clears the metadata when playback stops', () => {
		const mediaSession = { metadata: { title: 'Previous song' } };
		vi.stubGlobal('navigator', { mediaSession });

		updateMediaSessionMetadata(null);

		expect(mediaSession.metadata).toBeNull();
	});

	it('registers handlers for system next and previous controls', () => {
		const setActionHandler = vi.fn();
		vi.stubGlobal('navigator', { mediaSession: { setActionHandler } });
		const handler = vi.fn();

		setMediaSessionActionHandler('nexttrack', handler);
		setMediaSessionActionHandler('previoustrack', null);

		expect(setActionHandler).toHaveBeenNthCalledWith(1, 'nexttrack', handler);
		expect(setActionHandler).toHaveBeenNthCalledWith(2, 'previoustrack', null);
	});
});
