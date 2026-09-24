// Shared Svelte transitions. All collapse to 0ms under prefers-reduced-motion.
import type { TransitionConfig } from 'svelte/transition';

const query = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
const reduced = () => !!query?.matches;

/** Apple's default "ease out" spring approximation. */
export const easeOut = (t: number) => 1 - Math.pow(1 - t, 3.2);
/** Slight overshoot for things that "land". */
export const easeBack = (t: number) => {
	const c = 1.4;
	return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
};

/** Page content rising in on navigation. */
export function pageIn(_node: Element, { duration = 320 } = {}): TransitionConfig {
	return {
		duration: reduced() ? 0 : duration,
		easing: easeOut,
		css: (t) => `opacity:${t};transform:translateY(${(1 - t) * 14}px)`
	};
}

/** Full-screen sheet sliding up from the bottom (and back down on close). */
export function sheet(_node: Element, { duration = 460, offset = 0 } = {}): TransitionConfig {
	// `offset` lets a swipe-to-dismiss continue from where the finger let go.
	return {
		duration: reduced() ? 0 : offset ? duration * 0.7 : duration,
		easing: easeOut,
		css: (t, u) =>
			`transform:translateY(calc(${u * 100}% + ${t * offset}px));border-radius:${u * 28}px ${u * 28}px 0 0`
	};
}

/** Popover/menu scale-fade from its anchor corner. */
export function pop(_node: Element, { duration = 160, from = 0.94 } = {}): TransitionConfig {
	return {
		duration: reduced() ? 0 : duration,
		easing: easeOut,
		css: (t) => `opacity:${t};transform:scale(${from + (1 - from) * t})`
	};
}

/** Centered dialog: combines the translate(-50%,-50%) centring with a scale. */
export function dialog(_node: Element, { duration = 240 } = {}): TransitionConfig {
	return {
		duration: reduced() ? 0 : duration,
		easing: easeBack,
		css: (t) => `opacity:${Math.min(1, t * 1.5)};transform:translate(-50%,-50%) scale(${0.9 + 0.1 * t})`
	};
}

/** Toast rising from below its resting spot (keeps the translateX(-50%) centring). */
export function toast(_node: Element, { duration = 280 } = {}): TransitionConfig {
	return {
		duration: reduced() ? 0 : duration,
		easing: easeBack,
		css: (t) => `opacity:${t};transform:translateX(-50%) translateY(${(1 - t) * 24}px) scale(${0.92 + 0.08 * t})`
	};
}

/** Mini player sliding up over the tab bar. */
export function rise(_node: Element, { duration = 360, distance = 40 } = {}): TransitionConfig {
	return {
		duration: reduced() ? 0 : duration,
		easing: easeBack,
		css: (t) => `opacity:${t};transform:translateY(${(1 - t) * distance}px)`
	};
}

/** Artwork swap on track change: new art scales up from slightly smaller. */
export function artSwap(_node: Element, { duration = 420 } = {}): TransitionConfig {
	return {
		duration: reduced() ? 0 : duration,
		easing: easeOut,
		css: (t) => `opacity:${t};transform:scale(${0.92 + 0.08 * t})`
	};
}

export function fadeOnly(_node: Element, { duration = 200, delay = 0 } = {}): TransitionConfig {
	return { duration: reduced() ? 0 : duration, delay: reduced() ? 0 : delay, css: (t) => `opacity:${t}` };
}

/** Text crossfade with a small horizontal drift, for track titles. */
export function textSwap(_node: Element, { duration = 300, dx = 10 } = {}): TransitionConfig {
	return {
		duration: reduced() ? 0 : duration,
		easing: easeOut,
		css: (t) => `opacity:${t};transform:translateX(${(1 - t) * dx}px)`
	};
}
