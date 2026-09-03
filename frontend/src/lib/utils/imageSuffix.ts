type ComponentSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'hero' | 'full';

export function appendAudioDBSizeSuffix(url: string, size: ComponentSize): string {
	// Spotify CDN URLs are already complete image URLs. Appending AudioDB's
	// `/small` or `/medium` path would turn them into 404s.
	if (!url.includes('theaudiodb.com')) return url;
	if (url.endsWith('/small') || url.endsWith('/medium')) {
		return url;
	}

	switch (size) {
		case 'xs':
		case 'sm':
		case 'md':
			return `${url}/small`;
		case 'lg':
		case 'xl':
		case 'hero':
			return `${url}/medium`;
		case 'full':
			return url;
	}
}
