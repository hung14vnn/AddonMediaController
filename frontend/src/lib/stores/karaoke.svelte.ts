import { api } from '$lib/api/client';
import { API } from '$lib/constants';
import type { SourceType } from '$lib/player/types';
import { playerStore } from '$lib/stores/player.svelte';

export type KaraokeStatus =
	| 'idle'
	| 'not_generated'
	| 'preparing'
	| 'queued'
	| 'processing'
	| 'ready'
	| 'failed';

interface KaraokeJob {
	job_id: string | null;
	cache_key: string;
	status: 'not_generated' | 'queued' | 'processing' | 'ready' | 'failed';
	cached: boolean;
	instrumental_url: string | null;
	vocals_url: string | null;
	error_message: string | null;
}

const KARAOKE_POLL_INTERVALS_MS = [3000, 5000, 7500, 10000] as const;

class KaraokeController {
	status = $state<KaraokeStatus>('idle');
	error = $state('');

	private requestGeneration = 0;
	private trackKey: string | undefined;

	syncTrack(trackId: string | undefined, sourceType?: SourceType): void {
		const trackKey = trackId ? `${sourceType ?? ''}:${trackId}` : undefined;
		if (trackKey === this.trackKey) return;
		this.trackKey = trackKey;
		const generation = ++this.requestGeneration;
		this.status = 'idle';
		this.error = '';
		if (trackId && sourceType === 'local') void this.refreshStatus(trackId, generation);
	}

	private async refreshStatus(trackId: string, generation: number): Promise<void> {
		let pollAttempt = 0;
		try {
			while (true) {
				const status = await api.global.get<KaraokeJob>(API.karaoke.status(trackId));
				if (generation !== this.requestGeneration) return;
				this.status = status.status;
				this.error = status.status === 'failed' ? status.error_message || '' : '';
				if (status.status !== 'queued' && status.status !== 'processing') return;

				const intervalIndex = Math.min(pollAttempt, KARAOKE_POLL_INTERVALS_MS.length - 1);
				await new Promise((resolve) =>
					setTimeout(resolve, KARAOKE_POLL_INTERVALS_MS[intervalIndex])
				);
				pollAttempt += 1;
			}
		} catch {
			// Status discovery is advisory. Keep the normal idle state if the lookup fails.
		}
	}

	async toggle(): Promise<void> {
		const item = playerStore.currentQueueItem;
		if (!item || item.sourceType !== 'local') return;

		if (playerStore.karaokeActive) {
			try {
				await playerStore.deactivateKaraoke();
				this.status = 'ready';
			} catch (error) {
				this.fail(error);
			}
			return;
		}

		this.error = '';
		this.status = 'preparing';
		const generation = ++this.requestGeneration;
		try {
			let job = await api.global.post<KaraokeJob>(API.karaoke.prepare(), {
				track_file_id: item.trackSourceId
			});
			let pollAttempt = 0;
			while (job.status === 'queued' || job.status === 'processing') {
				if (generation !== this.requestGeneration) return;
				this.status = job.status;
				const intervalIndex = Math.min(pollAttempt, KARAOKE_POLL_INTERVALS_MS.length - 1);
				await new Promise((resolve) =>
					setTimeout(resolve, KARAOKE_POLL_INTERVALS_MS[intervalIndex])
				);
				pollAttempt += 1;
				if (generation !== this.requestGeneration) return;
				if (!job.job_id) throw new Error('Karaoke job identifier is missing');
				job = await api.global.get<KaraokeJob>(API.karaoke.job(job.job_id));
			}
			if (generation !== this.requestGeneration) return;
			if (job.status === 'failed') {
				throw new Error(job.error_message || 'Karaoke generation failed');
			}
			if (!job.instrumental_url || !job.vocals_url) {
				throw new Error('Karaoke stems are incomplete');
			}
			await playerStore.activateKaraoke(job.instrumental_url, job.vocals_url);
			if (generation === this.requestGeneration) this.status = 'ready';
		} catch (error) {
			if (generation === this.requestGeneration) this.fail(error);
		}
	}

	private fail(error: unknown): void {
		this.status = 'failed';
		this.error = error instanceof Error ? error.message : 'Karaoke generation failed';
	}
}

export const karaokeController = new KaraokeController();
