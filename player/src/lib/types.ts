export interface Song {
	id: string;
	title: string;
	album?: string;
	albumId?: string;
	artist?: string;
	artistId?: string;
	displayArtist?: string;
	artists?: { id: string; name: string }[];
	track?: number;
	discNumber?: number;
	year?: number;
	genre?: string;
	coverArt?: string;
	duration?: number;
	bitRate?: number;
	suffix?: string;
	contentType?: string;
	starred?: string;
	explicitStatus?: string;
	/** OpenSubsonic: zero or more ISRCs. */
	isrc?: string[];
}

export interface Album {
	id: string;
	name: string;
	artist?: string;
	artistId?: string;
	displayArtist?: string;
	coverArt?: string;
	songCount?: number;
	duration?: number;
	year?: number;
	genre?: string;
	starred?: string;
	created?: string;
	releaseTypes?: string[];
	isCompilation?: boolean;
	explicitStatus?: string;
	song?: Song[];
}

export interface Artist {
	id: string;
	name: string;
	coverArt?: string;
	artistImageUrl?: string;
	albumCount?: number;
	starred?: string;
	album?: Album[];
}

export interface ArtistInfo {
	biography?: string;
	largeImageUrl?: string;
	mediumImageUrl?: string;
	similarArtist?: Artist[];
}

export interface Playlist {
	id: string;
	name: string;
	comment?: string;
	owner?: string;
	public?: boolean;
	songCount?: number;
	duration?: number;
	coverArt?: string;
	changed?: string;
	entry?: Song[];
}

export interface Genre {
	value: string;
	songCount?: number;
	albumCount?: number;
}

export interface LyricLine {
	start?: number;
	value: string;
}

export interface Lyrics {
	synced: boolean;
	lines: LyricLine[];
}

export type AlbumListType =
	| 'random'
	| 'newest'
	| 'highest'
	| 'frequent'
	| 'recent'
	| 'alphabeticalByName'
	| 'alphabeticalByArtist'
	| 'starred'
	| 'byYear'
	| 'byGenre';
