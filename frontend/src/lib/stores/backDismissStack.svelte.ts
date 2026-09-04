type BackDismissEntry = {
	dismiss: () => void;
};

const entries: BackDismissEntry[] = [];

/** Register an open overlay so browser Back can dismiss it before routing. */
export function registerBackDismiss(dismiss: () => void): () => void {
	const entry = { dismiss };
	entries.push(entry);

	return () => {
		const index = entries.indexOf(entry);
		if (index >= 0) entries.splice(index, 1);
	};
}

/** Dismiss the most recently opened overlay. Returns whether one was found. */
export function dismissTopBackOverlay(): boolean {
	const entry = entries.pop();
	if (!entry) return false;
	entry.dismiss();
	return true;
}
