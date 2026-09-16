import { browser } from '$app/environment';
import { goto } from '$app/navigation';
import { api } from '$lib/api/client';
import { API } from '$lib/constants';
import { withBasePath } from '$lib/utils/basePath';
import { clearUserSessionState } from '$lib/utils/userSessionCleanup';

// Clears browser-wide cache before navigating so the next user on a shared browser
// sees no prior personalized data; local state clears regardless of network success.
export async function logout(): Promise<void> {
	try {
		await api.global.post(API.auth.logout(), undefined, { timeoutMs: 4000 });
	} catch {
		// A failed revoke must not strand the user in a signed-in UI.
	}
	await clearUserSessionState().catch(() => undefined);
	if (browser && typeof window !== 'undefined') {
		window.location.href = withBasePath('/login');
	} else {
		await goto(withBasePath('/login'));
	}
}
