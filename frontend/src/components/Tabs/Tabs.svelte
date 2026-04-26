<script lang="ts" module>
	export interface TabDef {
		id: string;
		icon?: string | undefined;
		label: string;
	}
</script>

<script lang="ts">
	import { getContext, onMount } from 'svelte';
	import { type NavAreaController, type NavPos } from '../../scripts/navArea.svelte.ts';
	import Icon from '../Icon/Icon.svelte';
	interface Props {
		tabs: TabDef[]; // Tab definitions. Each tab needs a unique `id`, optional `icon` and a visible `label`
		activeID: string; // Currently active tab id. Two-way bindable so the consumer can react to changes
		/**
		 * Top-left position of the tab row in the parent NavArea grid.
		 * When set, each tab is registered as a NavItem at `[position[0]+i, position[1]]`
		 * and auto-switches the active tab on selection (no confirm required).
		 */
		position?: NavPos | undefined;
		/**
		 * Explicit index of the visually-selected tab. Used by pages that own their own
		 * navigation system (e.g. legacy `useArea` based pages) and don't register navItems.
		 * Ignored when `position` is set (NavArea selection takes over).
		 */
		selectedIndex?: number | undefined;
		selectionActive?: boolean | undefined; // Whether the row that owns the visual selection is currently active
		compact?: boolean | undefined; // Compact rendering (smaller padding + font), for tight contexts like download detail
		onChange?: ((id: string) => void) | undefined; // Optional change callback (fires after `activeID` flips)
	}
	let { tabs, activeID = $bindable(), position, selectedIndex, selectionActive = true, compact = false, onChange }: Props = $props();

	const navArea = getContext<NavAreaController | undefined>('navArea');
	let elements = $state<Array<HTMLDivElement | undefined>>([]);

	function setActive(id: string): void {
		if (activeID === id) return;
		activeID = id;
		onChange?.(id);
	}

	// Per-tab state derived from current selection mode.
	function isTabSelected(i: number): boolean {
		if (position && navArea) return navArea.isSelected([position[0] + i, position[1]]);
		if (selectedIndex !== undefined && selectionActive) return i === selectedIndex;
		return false;
	}

	function colorVariable(i: number, tab: TabDef): string {
		if (isTabSelected(i)) return '--primary-background';
		if (activeID === tab.id) return '--primary-foreground';
		return '--secondary-foreground';
	}

	function makeClickHandler(id: string): () => void {
		return () => setActive(id);
	}
	function makeKeyHandler(id: string): (e: KeyboardEvent) => void {
		return (e: KeyboardEvent): void => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				setActive(id);
			}
		};
	}

	onMount(() => {
		// When embedded in a NavArea via `position`, register each tab as a NavItem with both
		// onConfirm (click/Enter) and onActivate (auto-switch on focus traversal).
		if (!position || !navArea) return;
		const unregisters: Array<() => void> = [];
		for (let i = 0; i < tabs.length; i++) {
			const tab = tabs[i]!;
			const idx = i;
			unregisters.push(
				navArea.register({
					get pos(): NavPos {
						return [position![0] + idx, position![1]];
					},
					get el(): HTMLElement | undefined {
						return elements[idx];
					},
					onConfirm: () => setActive(tab.id),
					onActivate: () => setActive(tab.id),
				})
			);
		}
		return () => {
			for (const u of unregisters) u();
		};
	});
</script>

<style>
	.tab-header {
		display: flex;
		gap: 0;
		border-bottom: 0.2vh solid var(--secondary-softer-background);
		flex-shrink: 0;
	}

	.tab {
		flex: 1;
		padding: 1.5vh 2vh;
		font-size: 1.8vh;
		background: transparent;
		border: none;
		color: var(--secondary-foreground);
		cursor: none;
		font-family: inherit;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 1vh;
		outline: none;
		transition: all 0.15s linear;
	}

	.tab.compact {
		padding: 1vh 2vh;
		font-size: 1.4vh;
		gap: 0.8vh;
	}

	.tab.active {
		color: var(--primary-foreground);
		border-bottom: 0.3vh solid var(--primary-foreground);
	}

	.tab.selected {
		background: var(--primary-foreground);
		color: var(--primary-background);
	}
</style>

<div class="tab-header">
	{#each tabs as tab, i (tab.id)}
		<div bind:this={elements[i]} class="tab" class:compact class:active={activeID === tab.id} class:selected={isTabSelected(i)} role="button" tabindex="-1" onclick={makeClickHandler(tab.id)} onkeydown={makeKeyHandler(tab.id)}>
			{#if tab.icon}
				<Icon img={tab.icon} size={compact ? '1.4vh' : '1.8vh'} padding="0" colorVariable={colorVariable(i, tab)} />
			{/if}
			{tab.label}
		</div>
	{/each}
</div>
