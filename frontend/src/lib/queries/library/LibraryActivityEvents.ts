import { API } from '$lib/constants';
import { getApiUrl } from '$lib/api/api-utils';
import { invalidateQueriesWithPersister } from '$lib/queries/QueryClient';
import { LibraryQueryKeyFactory } from './LibraryQueryKeyFactory';

export function createLibraryActivityEvents() {
	let activitySource: EventSource | null = null;
	let operationsSource: EventSource | null = null;

	function invalidateActivity(): void {
		void invalidateQueriesWithPersister({ queryKey: LibraryQueryKeyFactory.activityPrefix() });
	}

	function invalidateOperations(): void {
		void invalidateQueriesWithPersister({ queryKey: LibraryQueryKeyFactory.operationsPrefix() });
		void invalidateQueriesWithPersister({ queryKey: LibraryQueryKeyFactory.reviewsPrefix() });
		invalidateActivity();
	}

	function start(admin: boolean): void {
		stop();
		activitySource = new EventSource(getApiUrl(API.library.activityStream()), {
			withCredentials: true
		});
		activitySource.addEventListener('open', invalidateActivity);
		activitySource.addEventListener('activity.changed', invalidateActivity);
		if (admin) {
			operationsSource = new EventSource(getApiUrl(API.library.operationsStream()), {
				withCredentials: true
			});
			operationsSource.addEventListener('open', invalidateOperations);
			operationsSource.addEventListener('activity.changed', invalidateOperations);
		}
	}

	function stop(): void {
		activitySource?.close();
		operationsSource?.close();
		activitySource = null;
		operationsSource = null;
	}

	return { start, stop };
}
