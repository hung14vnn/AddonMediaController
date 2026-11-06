import type { Genre } from './types';

/**
 * Standard, curated categories matching Apple Music / Spotify browse genres,
 * replacing raw Subsonic tags that contain inconsistent or localized entries.
 */
export const APPLE_MUSIC_GENRES: Genre[] = [
	{ value: 'Pop' },
	{ value: 'Asian Music' },
	{ value: 'Alternative' },
	{ value: 'R&B' },
	{ value: 'Dance' },
	{ value: 'Rap/Hip Hop' },
	{ value: 'Rock' },
	{ value: 'Electronic' },
	{ value: 'K-Pop' },
	{ value: 'V-Pop' },
	{ value: 'J-Pop' },
	{ value: 'Indie' },
	{ value: 'Country' },
	{ value: 'Classical' },
	{ value: 'Jazz' },
	{ value: 'Latin' },
	{ value: 'Metal' },
	{ value: 'Acoustic' },
	{ value: 'Chill' },
	{ value: 'Soundtracks' },
	{ value: 'Blues' },
	{ value: 'Reggae' },
	{ value: 'Punk' },
	{ value: 'Folk' }
];
