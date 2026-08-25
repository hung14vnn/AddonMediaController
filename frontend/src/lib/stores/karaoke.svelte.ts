import { api } from '$lib/api/client';
import { API } from '$lib/constants';
import { playerStore } from '$lib/stores/player.svelte';

export type KaraokeStatus = 'idle' | 'preparing' | 'queued' | 'processing' | 'ready' | 'failed';

interface KaraokeJob {
	job_id: string | null;
	cache_key: string;
	status: 'queued' | 'processing' | 'ready' | 'failed';
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
	private trackId: string | undefined;

	syncTrack(trackId: string | undefined): void {
		if (trackId === this.trackId) return;
		this.trackId = trackId;
		this.requestGeneration += 1;
		this.status = 'idle';
		this.error = '';
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
