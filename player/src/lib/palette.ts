// Derives an iOS-style Now Playing tint from cover art: the saturation-weighted
// average colour, muted and darkened so white text always reads on top of it,
// plus a vibrant accent and ambient glow.
import { coverUrl } from './api';
import { hue } from './format';

export interface Tint {
	top: string;
	bottom: string;
	accent?: string;
	glow?: string;
}

const cache = new Map<string, Tint | null>();

function fallbackTint(seed: string | undefined): Tint {
	const h = hue(seed ?? 'music');
	return {
		top: `hsl(${h} 45% 26%)`,
		bottom: `hsl(${h} 35% 12%)`,
		accent: `hsl(${h} 65% 48%)`,
		glow: `hsl(${h} 65% 55% / 0.45)`
	};
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
	r /= 255;
	g /= 255;
	b /= 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const l = (max + min) / 2;
	if (max === min) return [0, 0, l];
	const d = max - min;
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
	return [h * 60, s, l];
}

function measure(img: HTMLImageElement): Tint | null {
	const size = 24;
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = size;
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	if (!ctx) return null;
	ctx.drawImage(img, 0, 0, size, size);
	// Throws for cross-origin art served without CORS; caller falls back to the blur.
	const { data } = ctx.getImageData(0, 0, size, size);
	let r = 0;
	let g = 0;
	let b = 0;
	let weight = 0;
	let maxSat = -1;
	let accentH = 0;
	let accentS = 0;
	let accentL = 0;

	for (let i = 0; i < data.length; i += 4) {
		const [ph, ps, pl] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
		// Favour coloured mid-tones over near-white/near-black pixels.
		const w = 0.15 + ps * (1 - Math.abs(pl - 0.5) * 2);
		r += data[i] * w;
		g += data[i + 1] * w;
		b += data[i + 2] * w;
		weight += w;

		// Track the most vibrant color in midtones for ambient accent
		const vibrance = ps * (1 - Math.abs(pl - 0.5) * 1.5);
		if (vibrance > maxSat && pl >= 0.2 && pl <= 0.8) {
			maxSat = vibrance;
			accentH = ph;
			accentS = ps;
			accentL = pl;
		}
	}
	const [h, s, l] = rgbToHsl(r / weight, g / weight, b / weight);
	const sat = Math.min(s * 1.35, 0.70) * 100;
	const light = Math.min(Math.max(l, 0.20), 0.44);

	const accSat = Math.min((accentS || s) * 1.35, 0.85) * 100;
	const accLight = Math.min(Math.max(accentL || l, 0.28), 0.58) * 100;
	const accentColor = `hsl(${Math.round(accentH || h)} ${Math.round(accSat)}% ${Math.round(accLight)}%)`;
	const glowColor = `hsl(${Math.round(accentH || h)} ${Math.round(accSat)}% 55% / 0.45)`;

	return {
		top: `hsl(${h.toFixed(0)} ${sat.toFixed(0)}% ${((light + 0.05) * 100).toFixed(0)}%)`,
		bottom: `hsl(${h.toFixed(0)} ${(sat * 0.9).toFixed(0)}% ${(light * 0.55 * 100).toFixed(0)}%)`,
		accent: accentColor,
		glow: glowColor
	};
}

/**
 * Resolves synchronously (a plain value) once a cover has been measured, so pages that
 * are revisited can paint their tint in the same frame; `await` works on either form.
 */
export function artworkTint(coverArt: string | undefined): Tint | null | Promise<Tint | null> {
	if (!coverArt) return fallbackTint('default');
	if (cache.has(coverArt)) return cache.get(coverArt)!;
	const src = coverUrl(coverArt, 64);
	if (!src) return fallbackTint(coverArt);
	return new Promise((resolve) => {
		const img = new Image();
		img.crossOrigin = 'anonymous';
		img.decoding = 'async';
		img.onload = () => {
			let tint: Tint | null = null;
			try {
				tint = measure(img);
			} catch {
				tint = fallbackTint(coverArt);
			}
			if (!tint) tint = fallbackTint(coverArt);
			cache.set(coverArt, tint);
			resolve(tint);
		};
		img.onerror = () => {
			const tint = fallbackTint(coverArt);
			cache.set(coverArt, tint);
			resolve(tint);
		};
		img.src = src;
	});
}

/**
 * Svelte action: paints `coverArt` into a tiny canvas that CSS stretches to fill
 * its box. The browser's bilinear upscaling produces a soft, blur-like wash with
 * none of the per-frame cost of `filter: blur()`. Drawing never needs pixel
 * readback, so cross-origin art without CORS still works (canvas just taints).
 */
export function softArt(canvas: HTMLCanvasElement, coverArt: string | undefined) {
	const size = 12;
	canvas.width = canvas.height = size;
	let token = 0;
	const paint = (art: string | undefined) => {
		const run = ++token;
		const src = coverUrl(art, 64);
		if (!src) return;
		const img = new Image();
		img.decoding = 'async';
		img.onload = () => {
			if (run !== token) return;
			const ctx = canvas.getContext('2d');
			if (!ctx) return;
			ctx.imageSmoothingQuality = 'high';
			// Colour grading is baked in once here rather than as a live CSS filter.
			ctx.filter = 'saturate(1.4)';
			ctx.drawImage(img, 0, 0, size, size);
			ctx.filter = 'none';
			ctx.fillStyle = 'rgb(0 0 0 / 0.25)';
			ctx.fillRect(0, 0, size, size);
		};
		img.src = src;
	};
	paint(coverArt);
	return {
		update: paint,
		destroy: () => void token++
	};
}
