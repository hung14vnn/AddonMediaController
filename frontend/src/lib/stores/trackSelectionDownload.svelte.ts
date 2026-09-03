/** Global state for choosing individual Spotify tracks before requesting them. */
export type TrackSelectionItem = {
	id: string;
	title: string;
	trackNumber: number;
	discNumber: number;
	durationMs?: number | null;
};

type TrackSelectionState = {
	open: boolean;
	albumId: string;
	albumTitle: string;
	artistName: string;
	tracks: TrackSelectionItem[];
};

const initial: TrackSelectionState = {
	open: false,
	albumId: '',
	albumTitle: '',
	artistName: '',
	tracks: []
};

let state = $state<TrackSelectionState>({ ...initial });

export const trackSelectionDownloadStore = {
	get open() {
		return state.open;
	},
	get albumId() {
		return state.albumId;
	},
	get albumTitle() {
		return state.albumTitle;
	},
	get artistName() {
		return state.artistName;
	},
	get tracks() {
		return state.tracks;
	},

	show(albumId: string, albumTitle: string, artistName: string, tracks: TrackSelectionItem[] = []) {
		state = { open: true, albumId, albumTitle, artistName, tracks };
	},

	setTracks(tracks: TrackSelectionItem[]) {
		state.tracks = tracks;
	},

	close() {
		state = { ...initial };
	}
};
