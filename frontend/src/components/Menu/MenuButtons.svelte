<script lang="ts" module>
	export interface MenuButtonRegistration {
		index: number;
		unregister: () => void;
	}
	export type MenuButtonsContext = {
		register: (button: { onConfirm?: (() => void) | undefined }) => MenuButtonRegistration;
		isSelected: (index: number) => boolean;
		isPressed: (index: number) => boolean;
		handleClick: (index: number) => void;
	};
</script>

<script lang="ts">
	import { type Snippet } from 'svelte';
	import { setContext, onMount, untrack } from 'svelte';
	import { useArea, activateArea, activeArea } from '../../scripts/areas.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	interface Props {
		children: Snippet;
		areaID: string;
		position: Position;
		initialIndex?: number | undefined;
		orientation?: 'horizontal' | 'vertical' | undefined;
		gap?: string | undefined;
		justify?: string | undefined;
		alignItems?: string | undefined;
		wrap?: boolean | undefined;
		onBack?: (() => void) | undefined;
	}
	let { children, areaID, position, initialIndex = 0, orientation = 'vertical', gap, justify, alignItems = 'center', wrap = false, onBack }: Props = $props();
	let effectiveGap = $derived(gap ?? (orientation === 'horizontal' ? '3vh' : '2vh'));
	let selectedIndex = $state(untrack(() => initialIndex));
	let isAPressed = $state(false);
	let buttons: { onConfirm?: (() => void) | undefined }[] = [];
	let active = $derived($activeArea === areaID);
	let itemsElement = $state<HTMLElement | null>(null);
	let translateX = $state(0);

	// Mouse wheel & drag scrolling
	let dragStartY = 0;
	let dragStartX = 0;
	let dragBaseTranslateX = 0;
	let isDragging = false;
	let didDrag = false;
	// Live 1:1 drag (horizontal): disables the snap transition so the row tracks the pointer exactly.
	let liveDragging = $state(false);
	// Vertical drag steps one item per this many pixels (there is no translateY to follow).
	const DRAG_THRESHOLD = 60;
	// Pointer travel (px) before a press counts as a drag instead of a click.
	const CLICK_DRAG_THRESHOLD = 5;

	function selectPrev(): void {
		if (selectedIndex > 0) {
			activateArea(areaID);
			selectedIndex--;
			updateTranslateX();
		}
	}

	function selectNext(): void {
		if (selectedIndex < buttons.length - 1) {
			activateArea(areaID);
			selectedIndex++;
			updateTranslateX();
		}
	}

	function handleWheel(e: WheelEvent): void {
		if (e.deltaY > 0 || e.deltaX > 0) {
			if (selectedIndex < buttons.length - 1) {
				e.preventDefault();
				selectNext();
			}
		} else if (e.deltaY < 0 || e.deltaX < 0) {
			if (selectedIndex > 0) {
				e.preventDefault();
				selectPrev();
			}
		}
	}

	function handleDragStart(e: MouseEvent): void {
		isDragging = true;
		didDrag = false;
		dragStartY = e.clientY;
		dragStartX = e.clientX;
		dragBaseTranslateX = translateX;
		if (orientation === 'horizontal') liveDragging = true;
		document.addEventListener('mousemove', handleDragMove);
		document.addEventListener('mouseup', handleDragEnd);
	}

	function handleDragMove(e: MouseEvent): void {
		if (!isDragging) return;
		if (orientation === 'horizontal') {
			// Follow the pointer 1:1 so the row moves by exactly the dragged distance.
			const delta = e.clientX - dragStartX;
			if (!didDrag && Math.abs(delta) <= CLICK_DRAG_THRESHOLD) return; // still a potential click
			didDrag = true;
			translateX = dragBaseTranslateX + delta;
		} else {
			// Vertical has no scroll offset to follow — step one item per threshold.
			const delta = dragStartY - e.clientY;
			if (Math.abs(delta) >= DRAG_THRESHOLD) {
				didDrag = true;
				if (delta > 0) selectNext();
				else selectPrev();
				dragStartY = e.clientY;
			}
		}
	}

	function handleDragEnd(): void {
		if (!isDragging) return;
		isDragging = false;
		document.removeEventListener('mousemove', handleDragMove);
		document.removeEventListener('mouseup', handleDragEnd);
		if (liveDragging) {
			liveDragging = false; // re-enable the snap transition
			if (didDrag) {
				// Snap the item nearest to centre into the selected/centred position.
				activateArea(areaID);
				selectedIndex = nearestIndexToCenter();
				updateTranslateX();
			}
		}
	}

	setContext<MenuButtonsContext>('menuButtons', {
		register(button): MenuButtonRegistration {
			const index = buttons.length;
			buttons.push(button);
			return {
				index,
				unregister(): void {
					buttons = buttons.filter((_, i) => i !== index);
				},
			};
		},
		isSelected(index): boolean {
			return active && selectedIndex === index;
		},
		isPressed(index): boolean {
			return active && selectedIndex === index && isAPressed;
		},
		handleClick(index: number): void {
			if (didDrag) {
				didDrag = false;
				return;
			}
			activateArea(areaID);
			selectedIndex = index;
			updateTranslateX();
			buttons[index]?.onConfirm?.();
		},
	});

	// Distance from the row's start to the centre of item `index` (positive px).
	function centerOffset(index: number): number {
		if (!itemsElement) return 0;
		const children = itemsElement.children;
		if (children.length === 0) return 0;
		let offset = 0;
		for (let i = 0; i < index; i++) offset += (children[i] as HTMLElement).offsetWidth;
		const gap = parseFloat(getComputedStyle(itemsElement).gap) || 0;
		offset += index * gap;
		const selectedChild = children[index] as HTMLElement;
		if (selectedChild) offset += selectedChild.offsetWidth / 2;
		return offset;
	}

	// After a free drag, pick the item whose centred position is closest to the current offset.
	function nearestIndexToCenter(): number {
		let best = selectedIndex;
		let bestDist = Infinity;
		for (let i = 0; i < buttons.length; i++) {
			const dist = Math.abs(-centerOffset(i) - translateX);
			if (dist < bestDist) {
				bestDist = dist;
				best = i;
			}
		}
		return best;
	}

	function updateTranslateX(): void {
		if (!itemsElement || orientation !== 'horizontal') return;
		if (itemsElement.children.length === 0) return;
		translateX = -centerOffset(selectedIndex);
	}

	onMount(() => {
		const handlers =
			orientation === 'horizontal'
				? {
						up(): boolean {
							return false;
						},
						down(): boolean {
							return false;
						},
						left(): boolean {
							if (selectedIndex > 0) {
								selectedIndex--;
								updateTranslateX();
								return true;
							}
							return false;
						},
						right(): boolean {
							if (selectedIndex < buttons.length - 1) {
								selectedIndex++;
								updateTranslateX();
								return true;
							}
							return false;
						},
					}
				: {
						up(): boolean {
							if (selectedIndex > 0) {
								selectedIndex--;
								return true;
							}
							return false;
						},
						down(): boolean {
							if (selectedIndex < buttons.length - 1) {
								selectedIndex++;
								return true;
							}
							return false;
						},
						left(): boolean {
							return false;
						},
						right(): boolean {
							return false;
						},
					};
		const unregister = useArea(
			areaID,
			{
				...handlers,
				confirmDown(): void {
					isAPressed = true;
				},
				confirmUp(): void {
					isAPressed = false;
					buttons[selectedIndex]?.onConfirm?.();
				},
				confirmCancel(): void {
					isAPressed = false;
				},
				back(): void {
					onBack?.();
				},
			},
			position
		);
		activateArea(areaID);
		updateTranslateX();
		return () => {
			unregister();
			document.removeEventListener('mousemove', handleDragMove);
			document.removeEventListener('mouseup', handleDragEnd);
		};
	});
</script>

<style>
	.buttons-wrapper {
		width: 100%;
		overflow: hidden;
		padding: 2vh 0;
	}

	.buttons {
		display: flex;
		transition: all 0.2s linear;
	}

	.buttons.dragging {
		transition: none;
	}

	.buttons.horizontal {
		flex-direction: row;
		padding: 0 50%;
	}

	.buttons.vertical {
		flex-direction: column;
	}

	.buttons.vertical :global(.menu-button) {
		width: 100%;
	}
</style>

{#if orientation === 'horizontal'}
	<div class="buttons-wrapper" onwheel={handleWheel} onmousedown={handleDragStart} role="listbox" tabindex="-1">
		<div class="buttons horizontal" class:dragging={liveDragging} bind:this={itemsElement} style="transform: translateX({translateX}px); gap: {effectiveGap}; align-items: {alignItems};{justify ? ` justify-content: ${justify};` : ''}{wrap ? ' flex-wrap: wrap;' : ''}">
			{@render children()}
		</div>
	</div>
{:else}
	<div class="buttons-wrapper" onwheel={handleWheel} onmousedown={handleDragStart} role="listbox" tabindex="-1">
		<div class="buttons vertical" style="gap: {effectiveGap}; align-items: {alignItems};{justify ? ` justify-content: ${justify};` : ''}{wrap ? ' flex-wrap: wrap;' : ''}">
			{@render children()}
		</div>
	</div>
{/if}
