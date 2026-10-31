import { api } from '$lib/api/client';
import { API } from '$lib/constants';
import type { SourceType } from '$lib/player/types';
import type { KaraokeJobResponse, KaraokePreviewStatus } from '$lib/types';
import { playerStore } from '$lib/stores/player.svelte';

export type KaraokeStatus =
	| 'idle'
	| 'not_generated'
	| 'preparing'
	| 'queued'
	| 'processing'
	| 'ready'
	| 'failed';

const KARAOKE_POLL_INTERVALS_MS = [1000, 1500, 2000, 3000, 5000] as const;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class KaraokeController {
	status = $state<KaraokeStatus>('idle');
	error = $state('');
	/** The AI separation is still running (a preview may already be playing). */
	waiting = $state(false);
	previewPlaying = $state(false);
	previewStatus = $state<KaraokePreviewStatus>('pending');

	private requestGeneration = 0;
	private trackKey: string | undefined;
	private sessionId: string | null = null;
	private previewAttempted = false;

	syncTrack(trackId: string | undefined, sourceType?: SourceType): void {
		const trackKey = trackId ? `${sourceType ?? ''}:${trackId}` : undefined;
		if (trackKey === this.trackKey) return;
		this.trackKey = trackKey;
		this.requestGeneration += 1;
		this.status = 'idle';
		this.error = '';
		this.waiting = false;
		this.previewPlaying = false;
		this.previewAttempted = false;
		this.previewStatus = 'pending';
		this.releaseSession();
		if (trackId && sourceType === 'local') void this.refreshStatus(trackId, this.requestGeneration);
	}

	dismiss(): void {
		this.waiting = false;
	}

	async toggle(): Promise<void> {
		const item = playerStore.currentQueueItem;
		if (!item || item.sourceType !== 'local') return;

		const busy =
			this.status === 'preparing' ||
			this.status === 'queued' ||
			this.status === 'processing';
		if (playerStore.karaokeActive || this.waiting || busy) {
			await this.stop();
			return;
		}

		this.error = '';
		this.status = 'preparing';
		this.waiting = true;
		this.previewPlaying = false;
		this.previewAttempted = false;
		this.previewStatus = 'pending';
		const generation = ++this.requestGeneration;
		const trackId = item.trackSourceId;
		try {
			let job = await api.global.post<KaraokeJobResponse>(API.karaoke.prepare(), {
				track_file_id: trackId
			});
			if (generation !== this.requestGeneration) {
				this.releaseJob(job);
				return;
			}
			this.sessionId = job.session_id;
			this.previewStatus = job.preview_status;
			await this.trackJob(job, generation);
		} catch (error) {
			if (generation === this.requestGeneration) await this.fail(error);
		}
	}

	async stop(): Promise<void> {
		this.requestGeneration += 1;
		this.waiting = false;
		this.previewPlaying = false;
		this.previewAttempted = false;
		this.previewStatus = 'pending';
		try {
			await playerStore.deactivateKaraoke();
		} catch {
			/* The original source is re-resolved on the next play attempt. */
		}
		this.releaseSession();
		this.status = 'not_generated';
		this.error = '';
	}

	private async trackJob(job: KaraokeJobResponse, generation: number): Promise<void> {
		let pollAttempt = 0;
		while (true) {
			if (generation !== this.requestGeneration) return;
			this.status = job.status;
			this.previewStatus = job.preview_status;
			this.error = job.status === 'failed' ? job.error_message || '' : '';

			if (job.status === 'ready') {
				await this.useStems(job, generation);
				return;
			}
			if (job.status === 'failed') {
				await this.handleFailure(job);
				return;
			}
			if (
				!this.previewAttempted &&
				job.preview_status === 'ready' &&
				job.preview_url
			) {
				this.previewAttempted = true;
				await this.playPreview(job.preview_url, generation);
			}

			const intervalIndex = Math.min(
				pollAttempt,
				KARAOKE_POLL_INTERVALS_MS.length - 1
			);
			await wait(KARAOKE_POLL_INTERVALS_MS[intervalIndex]);
			if (generation !== this.requestGeneration) return;
			if (!job.job_id) throw new Error('Karaoke job identifier is missing');
			job = await api.global.get<KaraokeJobResponse>(API.karaoke.job(job.job_id));
			pollAttempt += 1;
		}
	}

	private async useStems(job: KaraokeJobResponse, generation: number): Promise<void> {
		if (!job.instrumental_url || !job.vocals_url) {
			throw new Error('Karaoke stems are incomplete');
		}
		await playerStore.upgradeKaraoke(job.instrumental_url, job.vocals_url);
		if (generation !== this.requestGeneration) return;
		this.status = 'ready';
		this.waiting = false;
		this.previewPlaying = false;
	}

	private async playPreview(previewUrl: string, generation: number): Promise<void> {
		try {
			await playerStore.activateKaraokePreview(previewUrl);
		} catch {
			// The quick mix is optional; keep waiting for the AI stems.
			return;
		}
		if (generation !== this.requestGeneration) {
			// Karaoke was switched off while the preview was loading.
			if (!this.waiting) await playerStore.deactivateKaraoke();
			return;
		}
		this.previewPlaying = true;
	}

	private async handleFailure(job: KaraokeJobResponse): Promise<void> {
		this.error = job.error_message || 'Karaoke generation failed';
		this.status = 'failed';
		this.waiting = false;
		if (this.previewPlaying) return;
		this.releaseSession();
	}

	private async fail(error: unknown): Promise<void> {
		this.status = 'failed';
		this.error = error instanceof Error ? error.message : 'Karaoke generation failed';
		this.waiting = false;
		try {
			await playerStore.deactivateKaraoke();
		} catch {
			/* Best-effort restore; the next play re-resolves the original. */
		}
		this.previewPlaying = false;
		this.releaseSession();
	}

	private releaseJob(job: KaraokeJobResponse): void {
		if (job.session_id) void this.releaseSessionId(job.session_id);
	}

	private releaseSession(): void {
		const sessionId = this.sessionId;
		this.sessionId = null;
		if (sessionId) void this.releaseSessionId(sessionId);
	}

	private async releaseSessionId(sessionId: string): Promise<void> {
		try {
			await api.global.post(API.karaoke.release(), { session_id: sessionId });
		} catch {
			/* Idle cleanup removes an unreleased session. */
		}
	}

	private async refreshStatus(trackId: string, generation: number): Promise<void> {
		try {
			const status = await api.global.get<KaraokeJobResponse>(API.karaoke.status(trackId));
			if (generation !== this.requestGeneration) return;
			this.status = status.status;
			this.previewStatus = status.preview_status;
			this.error = status.status === 'failed' ? status.error_message || '' : '';
		} catch {
			// Status discovery is advisory. Keep the normal idle state if the lookup fails.
		}
	}
}

export const karaokeController = new KaraokeController();
