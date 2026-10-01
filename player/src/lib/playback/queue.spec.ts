import { describe, expect, it } from 'vitest';
import {
	cycleRepeat,
	indexAfterUnshuffle,
	interleaveEvenly,
	moveItem,
	nextIndex,
	planPlayOrder,
	removeAt,
	shuffleAround
} from './queue';

const songs = (...ids: string[]) => ids.map((id) => ({ id }));
const ids = (list: { id: string }[]) => list.map((s) => s.id);

describe('interleaveEvenly', () => {
	it('keeps every item and each list in its own order', () => {
		const a = ['a1', 'a2', 'a3', 'a4', 'a5'];
		const b = ['b1', 'b2', 'b3'];
		const out = interleaveEvenly(a, b);
		expect(out).toHaveLength(8);
		expect(out.filter((x) => x.startsWith('a'))).toEqual(a);
		expect(out.filter((x) => x.startsWith('b'))).toEqual(b);
	});

	it('handles an empty side', () => {
		expect(interleaveEvenly([], ['b1'])).toEqual(['b1']);
		expect(interleaveEvenly(['a1'], [])).toEqual(['a1']);
	});
});

describe('planPlayOrder', () => {
	const list = songs('a', 'b', 'c', 'd');

	it('plays in order from the tapped song when shuffle is off', () => {
		const order = planPlayOrder(list, 2, false, false);
		expect(ids(order.queue)).toEqual(['a', 'b', 'c', 'd']);
		expect(order).toMatchObject({ start: 2, shuffle: false, unshuffled: null });
	});

	it('keeps shuffle on with the tapped song first', () => {
		const order = planPlayOrder(list, 2, true, false);
		expect(order.queue[0].id).toBe('c');
		expect(ids(order.queue).sort()).toEqual(['a', 'b', 'c', 'd']);
		expect(order.start).toBe(0);
		expect(ids(order.unshuffled!)).toEqual(['a', 'b', 'c', 'd']);
	});

	it('shuffles everything on request and turns shuffle on', () => {
		const order = planPlayOrder(list, 3, false, true);
		expect(ids(order.queue).sort()).toEqual(['a', 'b', 'c', 'd']);
		expect(order).toMatchObject({ start: 0, shuffle: true });
	});
});

describe('shuffle on/off', () => {
	it('keeps the current track first when shuffling', () => {
		const { queue, index } = shuffleAround(songs('a', 'b', 'c', 'd'), 2);
		expect(index).toBe(0);
		expect(queue[0].id).toBe('c');
		expect(ids(queue).sort()).toEqual(['a', 'b', 'c', 'd']);
	});

	it('finds the current track again after unshuffling', () => {
		const original = songs('a', 'b', 'c');
		expect(indexAfterUnshuffle(original, { id: 'c' })).toBe(2);
		expect(indexAfterUnshuffle(original, { id: 'zz' })).toBe(0);
		expect(indexAfterUnshuffle(original, null)).toBe(-1);
	});
});

describe('removeAt / moveItem', () => {
	it('refuses to remove the current track', () => {
		const q = songs('a', 'b', 'c');
		expect(removeAt(q, 1, 1)).toBeNull();
		expect(ids(q)).toEqual(['a', 'b', 'c']);
	});

	it('shifts the current index when removing before it', () => {
		const q = songs('a', 'b', 'c');
		expect(removeAt(q, 2, 0)).toBe(1);
		expect(ids(q)).toEqual(['b', 'c']);
	});

	it('tracks the current song across moves', () => {
		let q = songs('a', 'b', 'c', 'd');
		expect(moveItem(q, 1, 0, 3)).toBe(0); // a moved past current b
		expect(ids(q)).toEqual(['b', 'c', 'd', 'a']);
		q = songs('a', 'b', 'c', 'd');
		expect(moveItem(q, 1, 3, 0)).toBe(2); // d moved before current b
		q = songs('a', 'b', 'c', 'd');
		expect(moveItem(q, 1, 2, 3)).toBe(1); // move entirely after current
	});
});

describe('nextIndex / cycleRepeat', () => {
	it('advances, wraps on repeat-all and stops at the end', () => {
		expect(nextIndex(3, 0, 'off')).toBe(1);
		expect(nextIndex(3, 2, 'off')).toBe(-1);
		expect(nextIndex(3, 2, 'all')).toBe(0);
		expect(nextIndex(0, -1, 'all')).toBe(-1);
	});

	it('cycles off → all → one → off', () => {
		expect(cycleRepeat('off')).toBe('all');
		expect(cycleRepeat('all')).toBe('one');
		expect(cycleRepeat('one')).toBe('off');
	});
});
