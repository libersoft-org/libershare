<script lang="ts" module>
	export type MenuButtonsContext = {
		register: (button: { onConfirm?: (() => void) | undefined }) => { index: number; unregister: () => void };
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
	let isDragging = false;
	let didDrag = false;
	const DRAG_THRESHOLD = 60;

	function selectPrev() {
		if (selectedIndex > 0) {
			activateArea(areaID);
			selectedIndex--;
			updateTranslateX();
		}
	}

	function selectNext() {
		if (selectedIndex < buttons.length - 1) {
			activateArea(areaID);
			selectedIndex++;
			updateTranslateX();
		}
	}

	function handleWheel(e: WheelEvent) {
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

	function handleDragStart(e: MouseEvent) {
		isDragging = true;
		didDrag = false;
		dragStartY = e.clientY;
		dragStartX = e.clientX;
		document.addEventListener('mousemove', handleDragMove);
		document.addEventListener('mouseup', handleDragEnd);
	}

	function handleDragMove(e: MouseEvent) {
		if (!isDragging) return;
		const isHoriz = orientation === 'horizontal';
		const delta = isHoriz ? dragStartX - e.clientX : dragStartY - e.clientY;
		if (Math.abs(delta) >= DRAG_THRESHOLD) {
			didDrag = true;
			if (delta > 0) selectNext();
			else selectPrev();
			dragStartY = e.clientY;
			dragStartX = e.clientX;
		}
	}

	function handleDragEnd() {
		isDragging = false;
		document.removeEventListener('mousemove', handleDragMove);
		document.removeEventListener('mouseup', handleDragEnd);
	}

	setContext<MenuButtonsContext>('menuButtons', {
		register(button) {
			const index = buttons.length;
			buttons.push(button);
			return {
				index,
				unregister() {
					buttons = buttons.filter((_, i) => i !== index);
				},
			};
		},
		isSelected(index) {
			return active && selectedIndex === index;
		},
		isPressed(index) {
			return active && selectedIndex === index && isAPressed;
		},
		handleClick(index: number) {
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

	function updateTranslateX(): void {
		if (!itemsElement || orientation !== 'horizontal') return;
		const children = itemsElement.children;
		if (children.length === 0) return;
		let offset = 0;
		for (let i = 0; i < selectedIndex; i++) {
			const child = children[i] as HTMLElement;
			offset += child.offsetWidth;
		}
		const gap = parseFloat(getComputedStyle(itemsElement).gap) || 0;
		offset += selectedIndex * gap;
		const selectedChild = children[selectedIndex] as HTMLElement;
		if (selectedChild) offset += selectedChild.offsetWidth / 2;
		translateX = -offset;
	}

	onMount(() => {
		const handlers =
			orientation === 'horizontal'
				? {
						up() {
							return false;
						},
						down() {
							return false;
						},
						left() {
							if (selectedIndex > 0) {
								selectedIndex--;
								updateTranslateX();
								return true;
							}
							return false;
						},
						right() {
							if (selectedIndex < buttons.length - 1) {
								selectedIndex++;
								updateTranslateX();
								return true;
							}
							return false;
						},
					}
				: {
						up() {
							if (selectedIndex > 0) {
								selectedIndex--;
								return true;
							}
							return false;
						},
						down() {
							if (selectedIndex < buttons.length - 1) {
								selectedIndex++;
								return true;
							}
							return false;
						},
						left() {
							return false;
						},
						right() {
							return false;
						},
					};
		const unregister = useArea(
			areaID,
			{
				...handlers,
				confirmDown() {
					isAPressed = true;
				},
				confirmUp() {
					isAPressed = false;
					buttons[selectedIndex]?.onConfirm?.();
				},
				confirmCancel() {
					isAPressed = false;
				},
				back() {
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
		<div class="buttons horizontal" bind:this={itemsElement} style="transform: translateX({translateX}px); gap: {effectiveGap}; align-items: {alignItems};{justify ? ` justify-content: ${justify};` : ''}{wrap ? ' flex-wrap: wrap;' : ''}">
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
