// Derives an iOS-style Now Playing tint from cover art: the saturation-weighted
// average colour, muted and darkened so white text always reads on top of it.
import { coverUrl } from './api';

export interface Tint {
	top: string;
	bottom: string;
}

const cache = new Map<string, Tint | null>();

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
	for (let i = 0; i < data.length; i += 4) {
		const [, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
		// Favour coloured mid-tones over near-white/near-black pixels.
		const w = 0.15 + s * (1 - Math.abs(l - 0.5) * 2);
		r += data[i] * w;
		g += data[i + 1] * w;
		b += data[i + 2] * w;
		weight += w;
	}
	const [h, s, l] = rgbToHsl(r / weight, g / weight, b / weight);
	const sat = Math.min(s, 0.45) * 100;
	const light = Math.min(Math.max(l, 0.24), 0.42);
	return {
		top: `hsl(${h.toFixed(0)} ${sat.toFixed(0)}% ${((light + 0.05) * 100).toFixed(0)}%)`,
		bottom: `hsl(${h.toFixed(0)} ${(sat * 0.9).toFixed(0)}% ${(light * 0.55 * 100).toFixed(0)}%)`
	};
}

export function artworkTint(coverArt: string | undefined): Promise<Tint | null> {
	if (!coverArt) return Promise.resolve(null);
	if (cache.has(coverArt)) return Promise.resolve(cache.get(coverArt)!);
	const src = coverUrl(coverArt, 64);
	if (!src) return Promise.resolve(null);
	return new Promise((resolve) => {
		const img = new Image();
		img.crossOrigin = 'anonymous';
		img.decoding = 'async';
		img.onload = () => {
			let tint: Tint | null = null;
			try {
				tint = measure(img);
			} catch {
				tint = null;
			}
			cache.set(coverArt, tint);
			resolve(tint);
		};
		img.onerror = () => resolve(null);
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
