// Smart Discover, ported from the main frontend's QueueDrawer: seed a YouTube Music
// radio mix with up to five random queue tracks, drop anything already queued, and
// spread the rest evenly through what's left to play.
import { getSmartDiscover } from './api';
import { getPlayer } from './player.svelte';
import type { Song } from './types';
import { ui } from './ui.svelte';

const MAX_SEEDS = 5;
const SUGGESTIONS = 15;

const trackKey = (s: Song) => `${(s.artist ?? s.displayArtist ?? '').toLowerCase()}|${s.title.toLowerCase()}`;

class SmartDiscover {
	discovering = $state(false);

	async run() {
		const player = getPlayer();
		const queue = player.queue;
		if (this.discovering || queue.length === 0) return;
		this.discovering = true;

		try {
			// Partial Fisher–Yates: a random sample of up to five seeds from the whole queue.
			const pool = [...queue];
			const count = Math.min(MAX_SEEDS, pool.length);
			for (let i = 0; i < count; i++) {
				const j = i + Math.floor(Math.random() * (pool.length - i));
				[pool[i], pool[j]] = [pool[j], pool[i]];
			}
			const seeds = pool.slice(0, count);

			const tracks = await getSmartDiscover(
				seeds.map((s) => ({ artist: s.artist ?? s.displayArtist ?? '', title: s.title })),
				SUGGESTIONS
			);
			if (!tracks.length) {
				ui.showToast('No suggestions found — try a different track');
				return;
			}

			const existing = new Set(player.queue.map(trackKey));
			const fresh = tracks.filter((t) => !existing.has(trackKey(t)));
			if (!fresh.length) {
				ui.showToast('All suggestions are already in queue');
				return;
			}

			player.interleaveUpNext(fresh);
			ui.showToast(`Discovered ${fresh.length} new track${fresh.length === 1 ? '' : 's'}`);
		} catch (e) {
			console.error('Smart Discover failed:', e);
			ui.showToast('Smart Discover failed — please try again');
		} finally {
			this.discovering = false;
		}
	}
}

export const smartDiscover = new SmartDiscover();
