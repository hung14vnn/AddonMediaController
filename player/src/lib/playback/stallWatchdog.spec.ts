import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_RECOVERIES, STALL_MS, StallWatchdog } from './stallWatchdog';

class FakeAudio extends EventTarget {
	paused = true;
	currentTime = 0;
	readyState = 4;
	fire(type: string) {
		this.dispatchEvent(new Event(type));
	}
	start() {
		this.paused = false;
		this.fire('play');
	}
	tick(t: number) {
		this.currentTime = t;
		this.fire('timeupdate');
	}
}

describe('StallWatchdog', () => {
	let audio: FakeAudio;
	let recover: ReturnType<typeof vi.fn<() => void>>;
	let watchdog: StallWatchdog;

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'] });
		audio = new FakeAudio();
		recover = vi.fn<() => void>();
		watchdog = new StallWatchdog(audio as unknown as HTMLAudioElement, recover);
		watchdog.track('a');
	});
	afterEach(() => {
		watchdog.dispose();
		vi.useRealTimers();
	});

	it('leaves healthy playback alone', () => {
		audio.start();
		for (let t = 1; t <= 20; t++) {
			audio.tick(t);
			vi.advanceTimersByTime(1000);
		}
		expect(recover).not.toHaveBeenCalled();
	});

	it('reloads when the clock freezes while playing', () => {
		audio.start();
		audio.tick(39);
		vi.advanceTimersByTime(STALL_MS + 2000);
		expect(recover).toHaveBeenCalledTimes(1);
	});

	it('ignores a frozen clock while paused', () => {
		audio.start();
		audio.paused = true;
		audio.fire('pause');
		vi.advanceTimersByTime(STALL_MS * 3);
		expect(recover).not.toHaveBeenCalled();
	});

	it(`gives up after ${MAX_RECOVERIES} reloads of the same track`, () => {
		audio.start();
		vi.advanceTimersByTime((STALL_MS + 2000) * (MAX_RECOVERIES + 3));
		expect(recover).toHaveBeenCalledTimes(MAX_RECOVERIES);
		// A different track gets a fresh budget; reloading the same one does not.
		watchdog.track('a');
		audio.start();
		vi.advanceTimersByTime(STALL_MS + 2000);
		expect(recover).toHaveBeenCalledTimes(MAX_RECOVERIES);
		watchdog.track('b');
		audio.start();
		vi.advanceTimersByTime(STALL_MS + 2000);
		expect(recover).toHaveBeenCalledTimes(MAX_RECOVERIES + 1);
	});

	it('asks for a reload on play only when starved and stuck', () => {
		expect(watchdog.needsReload()).toBe(false);
		vi.advanceTimersByTime(STALL_MS + 1);
		expect(watchdog.needsReload()).toBe(false); // has data: plain play() works
		audio.readyState = 1;
		expect(watchdog.needsReload()).toBe(true);
	});
});
