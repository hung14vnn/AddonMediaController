<script lang="ts" module>
	let activeMenu: HTMLDetailsElement | null = null;

	export function closeAllMenus() {
		if (activeMenu) {
			activeMenu.open = false;
			activeMenu = null;
		}
	}
</script>

<script lang="ts">
	import { ChevronDown, EllipsisVertical } from 'lucide-svelte';
	import { tick, type Component, type SvelteComponent } from 'svelte';

	const MENU_WIDTH = 208;
	const ITEM_HEIGHT_EST = 40;
	const MENU_PADDING = 16;
	const VIEWPORT_MARGIN = 8;

	export interface MenuItem {
		label: string;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Svelte framework limitation: icon components have varying prop signatures
		icon: Component<Record<string, any>> | (new (...args: any[]) => SvelteComponent<any>);
		onclick: () => void;
		disabled?: boolean;
		className?: string;
		submenu?: MenuItem[];
		submenuLabel?: string;
	}

	interface Props {
		items: MenuItem[];
		position?: 'start' | 'end';
		size?: 'xs' | 'sm';
	}

	let { items, position = 'end', size = 'sm' }: Props = $props();
	let detailsEl = $state<HTMLDetailsElement | null>(null);
	let summaryEl = $state<HTMLElement | null>(null);
	let menuEl = $state<HTMLUListElement | null>(null);
	let isOpen = $state(false);
	let menuTop = $state(0);
	let menuLeft = $state(0);
	let expandedSubmenu = $state<number | null>(null);

	function portal(node: HTMLElement) {
		document.body.appendChild(node);
		return {
			destroy() {
				node.remove();
			}
		};
	}

	function computeMenuPosition() {
		if (!summaryEl) return;
		const rect = summaryEl.getBoundingClientRect();

		menuTop = rect.bottom + 4;
		menuLeft = position === 'end' ? rect.right - MENU_WIDTH : rect.left;

		if (menuLeft < VIEWPORT_MARGIN) menuLeft = VIEWPORT_MARGIN;
		if (menuLeft + MENU_WIDTH > window.innerWidth - VIEWPORT_MARGIN) {
			menuLeft = window.innerWidth - MENU_WIDTH - VIEWPORT_MARGIN;
		}

		const menuHeight =
			menuEl?.getBoundingClientRect().height ?? items.length * ITEM_HEIGHT_EST + MENU_PADDING;
		if (menuTop + menuHeight > window.innerHeight - VIEWPORT_MARGIN) {
			menuTop = rect.top - menuHeight - 4;
			if (menuTop < VIEWPORT_MARGIN) menuTop = VIEWPORT_MARGIN;
		}
	}

	async function handleItemClick(item: MenuItem, index: number) {
		if (item.disabled) return;
		if (item.submenu?.length) {
			expandedSubmenu = expandedSubmenu === index ? null : index;
			await tick();
			computeMenuPosition();
			return;
		}
		if (detailsEl) detailsEl.open = false;
		item.onclick();
	}

	function handleClickOutside(e: MouseEvent) {
		const target = e.target as Node;
		if (detailsEl?.open && !detailsEl.contains(target) && !menuEl?.contains(target)) {
			detailsEl.open = false;
		}
	}

	function handleScroll(event: Event) {
		if (event.target instanceof Node && menuEl?.contains(event.target)) return;
		if (detailsEl?.open) {
			detailsEl.open = false;
		}
	}

	async function handleToggle() {
		const nowOpen = detailsEl?.open ?? false;
		if (nowOpen) {
			if (activeMenu && activeMenu !== detailsEl) {
				activeMenu.open = false;
			}
			activeMenu = detailsEl;
			computeMenuPosition();
		} else if (activeMenu === detailsEl) {
			activeMenu = null;
		}
		expandedSubmenu = null;
		isOpen = nowOpen;
		if (nowOpen) {
			await tick();
			computeMenuPosition();
		}
	}

	$effect(() => {
		if (isOpen) {
			document.addEventListener('click', handleClickOutside);
			window.addEventListener('scroll', handleScroll, true);
			return () => {
				document.removeEventListener('click', handleClickOutside);
				window.removeEventListener('scroll', handleScroll, true);
			};
		}
	});
</script>

<details
	bind:this={detailsEl}
	class="dropdown {position === 'start' ? 'dropdown-start' : 'dropdown-end'}"
	ontoggle={handleToggle}
>
	<summary
		bind:this={summaryEl}
		class="btn btn-ghost btn-circle {size === 'xs' ? 'btn-xs' : 'btn-sm'}"
		aria-haspopup="menu"
		aria-label="More actions"
		onclick={(e: MouseEvent) => e.stopPropagation()}
	>
		<EllipsisVertical class={size === 'xs' ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
	</summary>
</details>

{#if isOpen}
	<ul
		bind:this={menuEl}
		use:portal
		class="menu bg-base-200/95 backdrop-blur-md rounded-box shadow-lg w-52 p-2 flex-nowrap overflow-y-auto max-h-[calc(100dvh-16px)]"
		style="position: fixed; top: {menuTop}px; left: {menuLeft}px; z-index: 9999;"
		role="menu"
		onclick={(e: MouseEvent) => e.stopPropagation()}
		onkeydown={(e: KeyboardEvent) => {
			if (e.key === 'Escape' && detailsEl) detailsEl.open = false;
		}}
	>
		{#each items as item, i (`item-${i}`)}
			<li>
				<button
					role="menuitem"
					class="{item.disabled ? 'opacity-50 cursor-not-allowed' : ''} {item.className ?? ''}"
					disabled={item.disabled}
					aria-disabled={item.disabled ? 'true' : undefined}
					aria-expanded={item.submenu?.length ? expandedSubmenu === i : undefined}
					onclick={(e: MouseEvent) => {
						e.stopPropagation();
						void handleItemClick(item, i);
					}}
				>
					<item.icon class="h-4 w-4" />
					{item.label}
					{#if item.submenu?.length}
						<ChevronDown class="ml-auto h-3 w-3 {expandedSubmenu === i ? 'rotate-180' : ''}" />
					{/if}
				</button>
				{#if item.submenu?.length && expandedSubmenu === i}
					<ul>
						{#if item.submenuLabel}
							<li
								class="menu-title px-3 py-1 text-[11px] uppercase tracking-wide text-base-content/50"
							>
								{item.submenuLabel}
							</li>
						{/if}
						{#each item.submenu as child, j (`submenu-${i}-${j}`)}
							<li>
								<button
									role="menuitem"
									class="{child.disabled ? 'opacity-50 cursor-not-allowed' : ''} {child.className ??
										''}"
									disabled={child.disabled}
									onclick={(e: MouseEvent) => {
										e.stopPropagation();
										if (!child.disabled) {
											if (detailsEl) detailsEl.open = false;
											child.onclick();
										}
									}}
								>
									<child.icon class="h-4 w-4" />{child.label}
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</li>
		{/each}
	</ul>
{/if}
