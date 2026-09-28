import type { HandleClientError } from '@sveltejs/kit';

// Unknown paths just redirect home (see +error.svelte); only log real failures.
export const handleError: HandleClientError = ({ error, status }) => {
	if (status !== 404) console.error(error);
};
