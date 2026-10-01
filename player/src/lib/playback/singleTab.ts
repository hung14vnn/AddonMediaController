/** Lets only one tab play at a time (like music.apple.com). */
export class SingleTab {
	private channel: BroadcastChannel | null = null;
	private readonly tabId = Math.random().toString(36).slice(2);

	constructor(onOtherTabPlaying: () => void) {
		if (typeof BroadcastChannel === 'undefined') return;
		this.channel = new BroadcastChannel('music-player');
		this.channel.onmessage = (e) => {
			if (e.data?.type === 'playing' && e.data.tab !== this.tabId) onOtherTabPlaying();
		};
	}

	/** This tab started playing; the others pause. */
	announcePlaying() {
		this.channel?.postMessage({ type: 'playing', tab: this.tabId });
	}

	close() {
		this.channel?.close();
		this.channel = null;
	}
}
