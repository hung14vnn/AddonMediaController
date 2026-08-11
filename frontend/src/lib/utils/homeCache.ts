import { CACHE_KEYS, CACHE_TTL } from '$lib/constants';
import { createLocalStorageCache } from '$lib/utils/localStorageCache';
import type { HomeResponse } from '$lib/types';

const homeCache = createLocalStorageCache<HomeResponse>(CACHE_KEYS.HOME_CACHE, CACHE_TTL.HOME);

export const updateHomeCacheTTL = homeCache.updateTTL;

export function getGreeting(): string {
	const hour = new Date().getHours();
	if (hour < 12) return 'morning, sunshine!';
	if (hour < 18) return 'Rise and shine… oh wait, it is already afternoon';
	return 'night night, sleepy owl!';
}
