import { CACHE_KEYS, CACHE_TTL } from '$lib/constants';
import { createLocalStorageCache } from '$lib/utils/localStorageCache';
import type { HomeResponse } from '$lib/types';

const homeCache = createLocalStorageCache<HomeResponse>(CACHE_KEYS.HOME_CACHE, CACHE_TTL.HOME);

export const updateHomeCacheTTL = homeCache.updateTTL;

export function getGreeting(userName?: string | null): string {
	const name = userName?.trim() || 'there';
	const hour = new Date().getHours();
	if (hour < 12) return `morning, ${name}!`;
	if (hour < 18) return `halfway there, ${name}!`;
	return `night night, ${name}!`;
}
