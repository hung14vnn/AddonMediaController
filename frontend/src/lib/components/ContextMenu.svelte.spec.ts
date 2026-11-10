import '../../app.css';
import { page, userEvent } from '@vitest/browser/context';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ContextMenu from './ContextMenu.svelte';
import { closeAllMenus } from './ContextMenu.svelte';
import type { MenuItem } from './ContextMenu.svelte';
import { ListPlus, ListStart } from 'lucide-svelte';

function makeItems(overrides: Partial<MenuItem>[] = []): MenuItem[] {
	const defaults: MenuItem[] = [
		{ label: 'Add to Queue', icon: ListPlus, onclick: vi.fn() },
		{ label: 'Play Next', icon: ListStart, onclick: vi.fn() }
	];
	return defaults.map((d, i) => ({ ...d, ...overrides[i] }));
}

async function renderMenu(items: MenuItem[] = makeItems()) {
	return await render(ContextMenu, {
		props: { items }
	} as Parameters<typeof render<typeof ContextMenu>>[1]);
}

describe('ContextMenu.svelte', () => {
	beforeEach(() => {
		closeAllMenus();
	});

	afterEach(async () => {
		await page.viewport(1280, 720);
	});

	function compressionItems(): MenuItem[] {
		return [
			{
				label: 'Compress music',
				icon: ListPlus,
				onclick: vi.fn(),
				submenuLabel: 'FLAC · 30 MB',
				submenu: [
					{ label: 'AAC 256 kbps', icon: ListPlus, onclick: vi.fn() },
					{ label: 'Opus 192 kbps', icon: ListStart, onclick: vi.fn() }
				]
			},
			...makeItems()
		];
	}

	it('opens compression choices by click and invokes the selected format once', async () => {
		const items = compressionItems();
		await renderMenu(items);
		await page.getByLabelText('More actions').click();
		const compress = page.getByRole('menuitem', { name: 'Compress music' });
		await expect.element(compress).toHaveAttribute('aria-expanded', 'false');
		await compress.click();
		await expect.element(compress).toHaveAttribute('aria-expanded', 'true');
		await page.getByRole('menuitem', { name: 'Opus 192 kbps' }).click();
		expect(items[0].submenu![1].onclick).toHaveBeenCalledOnce();
		expect(items[0].onclick).not.toHaveBeenCalled();
		await expect.element(page.getByRole('menu')).not.toBeInTheDocument();
	});

	it.each([390, 1280])(
		'keeps compression choices inside a %ipx viewport at the bottom-right edge',
		async (width) => {
			await page.viewport(width, 720);
			await renderMenu(compressionItems());
			const trigger = page.getByLabelText('More actions');
			(trigger.element().closest('details') as HTMLElement).style.cssText =
				'position:fixed;right:8px;bottom:8px';
			await trigger.click();
			await page.getByRole('menuitem', { name: 'Compress music' }).click();
			const opus = page.getByRole('menuitem', { name: 'Opus 192 kbps' });
			await expect.element(opus).toBeVisible();
			await expect
				.poll(() => {
					const rect = opus.element().getBoundingClientRect();
					return rect.left >= 0 && rect.right <= width && rect.top >= 0 && rect.bottom <= 720;
				})
				.toBe(true);
		}
	);

	it('supports keyboard expansion, collapse, and closing with Escape', async () => {
		await renderMenu(compressionItems());
		await page.getByLabelText('More actions').click();
		const compress = page.getByRole('menuitem', { name: 'Compress music' });
		(compress.element() as HTMLElement).focus();
		await userEvent.keyboard('{Enter}');
		await expect.element(page.getByRole('menuitem', { name: 'AAC 256 kbps' })).toBeVisible();
		await userEvent.keyboard('{Enter}');
		await expect.element(compress).toHaveAttribute('aria-expanded', 'false');
		await userEvent.keyboard('{Escape}');
		await expect.element(page.getByRole('menu')).not.toBeInTheDocument();
	});

	it('keeps a tall menu open while scrolling its contents', async () => {
		await page.viewport(390, 240);
		await renderMenu([
			...compressionItems(),
			...Array.from({ length: 8 }, (_, i) => ({
				label: `Action ${i}`,
				icon: ListPlus,
				onclick: vi.fn()
			}))
		]);
		await page.getByLabelText('More actions').click();
		await page.getByRole('menuitem', { name: 'Compress music' }).click();
		const menu = page.getByRole('menu');
		const element = menu.element() as HTMLElement;
		expect(element.scrollHeight).toBeGreaterThan(element.clientHeight);
		element.scrollTop = element.scrollHeight;
		element.dispatchEvent(new Event('scroll'));
		await expect.element(menu).toBeVisible();
		await page.getByRole('menuitem', { name: 'Action 7', exact: true }).click();
		await expect.element(menu).not.toBeInTheDocument();
	});

	it('resets expanded choices after closing and reopening the menu', async () => {
		await renderMenu(compressionItems());
		await page.getByLabelText('More actions').click();
		await page.getByRole('menuitem', { name: 'Compress music' }).click();
		await userEvent.keyboard('{Escape}');
		await expect.element(page.getByRole('menu')).not.toBeInTheDocument();
		await page.getByLabelText('More actions').click();
		await expect
			.element(page.getByRole('menuitem', { name: 'Compress music' }))
			.toHaveAttribute('aria-expanded', 'false');
		await expect
			.element(page.getByRole('menuitem', { name: 'Opus 192 kbps' }))
			.not.toBeInTheDocument();
	});

	it('renders the trigger button', async () => {
		await renderMenu();
		await expect.element(page.getByLabelText('More actions')).toBeInTheDocument();
	});

	it('shows menu items when opened', async () => {
		await renderMenu();
		const trigger = page.getByLabelText('More actions');
		await trigger.click();
		await expect.element(page.getByText('Add to Queue')).toBeVisible();
		await expect.element(page.getByText('Play Next')).toBeVisible();
	});

	it('fires callback on item click and closes menu', async () => {
		const items = makeItems();
		await renderMenu(items);
		const trigger = page.getByLabelText('More actions');
		await trigger.click();
		await page.getByText('Add to Queue').click();
		expect(items[0].onclick).toHaveBeenCalledOnce();
	});

	it('renders disabled items as non-interactive', async () => {
		const items = makeItems([{ disabled: true }]);
		await renderMenu(items);
		const trigger = page.getByLabelText('More actions');
		await trigger.click();
		const disabledBtn = page.getByText('Add to Queue');
		await expect.element(disabledBtn).toBeVisible();
	});

	it('has correct ARIA roles', async () => {
		await renderMenu();
		const trigger = page.getByLabelText('More actions');
		await trigger.click();
		await expect.element(page.getByRole('menu')).toBeInTheDocument();
		const menuItems = page.getByRole('menuitem').all();
		expect(menuItems.length).toBeGreaterThanOrEqual(2);
	});

	it('does not have redundant role on summary', async () => {
		await renderMenu();
		const summary = page.getByLabelText('More actions');
		const roleAttr = await summary.element().getAttribute('role');
		expect(roleAttr).toBeNull();
	});

	it('opening a second menu closes the first', async () => {
		const items1: MenuItem[] = [{ label: 'Action A', icon: ListPlus, onclick: vi.fn() }];
		const items2: MenuItem[] = [{ label: 'Action B', icon: ListStart, onclick: vi.fn() }];

		await renderMenu(items1);
		await renderMenu(items2);

		const triggers = page.getByLabelText('More actions').all();
		expect((await triggers).length).toBe(2);
		((await triggers)[1].element().closest('details') as HTMLElement).style.cssText =
			'position:fixed;right:8px;top:8px';

		await (await triggers)[0].click();
		await expect.element(page.getByText('Action A')).toBeVisible();

		await (await triggers)[1].click();
		await expect.element(page.getByText('Action B')).toBeVisible();
		await expect.element(page.getByText('Action A')).not.toBeInTheDocument();
	});
});
