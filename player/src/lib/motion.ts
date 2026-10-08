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

/**
 * How a navigation animates (decided in the layout before it happens):
 * - `rise`: desktop — the new page rises in, the old one goes at once.
 * - `push` / `pop`: phones, iOS navigation style — the new page slides over the
 *   full width from the right while the old one drifts 30% left (push), and the
 *   reverse going back (pop).
 * - `tab`: phones, switching tabs — no slide, a quick fade (iOS swaps instantly).
 * - `none`: the browser already animated it (swipe-back gesture): swap at once.
 * `scroll` is the leaving page's scroll offset and `height` the visible height
 * of the scroll container, so the leaving page can be pinned in place.
 */
export interface PageMotion {
	kind: 'rise' | 'push' | 'pop' | 'tab' | 'none';
	scroll?: number;
	height?: number;
}

const PAGE_MS = 420;

/**
 * Static styles for the page on top while it slides: opaque, with an edge
 * shadow. Set inline for the duration, NOT inside the keyframes: any
 * non-transform property in them would keep the whole animation off the
 * compositor, and the slide would stutter whenever the main thread is busy
 * (e.g. the incoming page mounting its content).
 *
 * Stacking is fixed so nothing flips mid-way: pages sit at z-index 1 (layout
 * CSS), a page pushed away drops to 0, a page popped off rises to 2.
 */
function lift(node: HTMLElement) {
	node.style.background = 'var(--bg)';
	node.style.boxShadow = '-8px 0 28px rgb(0 0 0 / 0.18)';
}
/** How far that shadow spills past the page's left edge (offset + blur). */
const SHADOW_REACH = 8 + 28;

export function pageIn(node: HTMLElement, motion: PageMotion = { kind: 'rise' }): TransitionConfig {
	if (reduced() || motion.kind === 'none') return { duration: 0 };
	switch (motion.kind) {
		case 'push':
			lift(node);
			// Only once the slide has really finished (it starts a little after this
			// call), never on a timer that could fire while it is still moving.
			node.addEventListener(
				'introend',
				() => {
					node.style.background = node.style.boxShadow = '';
				},
				{ once: true }
			);
			return { duration: PAGE_MS, easing: easeOut, css: (_t, u) => `transform:translateX(${u * 100}%)` };
		case 'pop':
			return { duration: PAGE_MS, easing: easeOut, css: (_t, u) => `transform:translateX(${u * -30}%)` };
		case 'tab':
			return { duration: 150, css: (t) => `opacity:${t}` };
		default:
			return {
				duration: 320,
				easing: easeOut,
				css: (t) => `opacity:${t};transform:translateY(${(1 - t) * 14}px)`
			};
	}
}

/** The leaving page: pinned where it was (out of the flow), then slid away. */
export function pageOut(node: HTMLElement, motion: PageMotion = { kind: 'rise' }): TransitionConfig {
	if (reduced() || (motion.kind !== 'push' && motion.kind !== 'pop')) return { duration: 0 };
	// Keep this page showing the part that was on screen while the scroll container
	// moves on to the new page (to the top, or to the restored offset going back). It is
	// pinned to the screen over the container rather than placed inside its scrolling
	// content: there it would stretch the scroll range until it is removed, so a restored
	// offset that the new page can't reach on its own would hold during the slide and
	// then snap back at the end. It is cut to one screen and scrolled inside itself, so
	// the sliding layer (and its shadow) is only a viewport in size.
	const box = node.parentElement?.getBoundingClientRect();
	Object.assign(node.style, {
		position: box ? 'fixed' : 'absolute',
		top: `${box?.top ?? 0}px`,
		left: `${box?.left ?? 0}px`,
		width: box ? `${node.parentElement!.clientWidth}px` : '100%',
		pointerEvents: 'none',
		zIndex: motion.kind === 'push' ? '0' : '2'
	});
	if (motion.height) {
		Object.assign(node.style, { height: `${motion.height}px`, minHeight: '0', overflow: 'hidden' });
		node.scrollTop = motion.scroll ?? 0;
	} else node.style.top = `${(box?.top ?? 0) - (motion.scroll ?? 0)}px`;
	if (motion.kind === 'pop') lift(node);
	return {
		duration: PAGE_MS,
		easing: easeOut,
		// Popping, the page slides out past the edge by its shadow's reach too (see lift()),
		// or the shadow stays on screen as a strip until the page is removed.
		css: (_t, u) =>
			motion.kind === 'push'
				? `transform:translateX(${u * -30}%)`
				: `transform:translateX(calc(${u * 100}% + ${u * SHADOW_REACH}px))`
	};
}

/** Full-screen sheet sliding up from the bottom (and back down on close). */
export function sheet(_node: Element, { duration = 460, offset = 0 } = {}): TransitionConfig {
	// `offset` lets a swipe-to-dismiss continue from where the finger let go.
	return {
		duration: reduced() ? 0 : offset ? duration * 0.7 : duration,
		easing: easeOut,
		css: (t, u) =>
			`transform:translateY(calc(${u * 100}% + ${t * offset}px));border-radius:${16 + u * 12}px ${16 + u * 12}px 0 0`
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

/** Queue row entrance/exit when the current track advances. */
export function queueItem(
	_node: Element,
	{ duration = 220, delay = 0, direction = 1 } = {}
): TransitionConfig {
	return {
		duration: reduced() ? 0 : duration,
		delay: reduced() ? 0 : delay,
		easing: easeOut,
		css: (t) => {
			const distance = (1 - t) * 36 * direction;
			return `opacity:${t};transform:translateX(${distance}px)`;
		}
	};
}
