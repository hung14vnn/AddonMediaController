// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
	namespace App {}

	/** Injected by vite.config.ts at build time. */
	const __BUILD__: { version: string; commit: string; time: string };
}

export {};
