<script lang="ts">
	import { onMount } from 'svelte';
	import { useArea, activeArea, activateArea, setAreaPosition, removeArea } from '../../scripts/areas.ts';
	interface Props {
		areaID: string;
		path: string;
		separator: string;
		onNavigate?: (path: string) => void;
		onUp?: () => void;
		onDown?: () => void;
	}
	let { areaID, path, separator, onNavigate, onUp, onDown }: Props = $props();
	let selectedIndex = $state(0);
	let active = $derived($activeArea === areaID);

	// Parse path into breadcrumb items with their full paths
	let breadcrumbItems = $derived.by(() => {
		if (!path) return [{ name: separator === '/' ? '/' : 'Drives', path: '' }];
		const parts = path.split(separator).filter(Boolean);
		const items: { name: string; path: string }[] = [];
		if (separator === '/') {
			// Linux: start with root "/"
			items.push({ name: '/', path: '/' });
			let currentPath = '';
			for (const part of parts) {
				currentPath += '/' + part;
				items.push({ name: part, path: currentPath });
			}
		} else {
			// Windows: start with drive list, then drive, then folders
			items.push({ name: 'Drives', path: '' });
			let currentPath = '';
			for (let i = 0; i < parts.length; i++) {
				if (i === 0) {
					// Drive letter (e.g., "C:")
					currentPath = parts[i] + separator;
					items.push({ name: parts[i], path: currentPath });
				} else {
					currentPath += parts[i];
					items.push({ name: parts[i], path: currentPath });
					if (i < parts.length - 1) currentPath += separator;
				}
			}
		}

		return items;
	});

	let maxIndex = $derived(breadcrumbItems.length - 2); // Last item (current) is not selectable

	const areaHandlers = {
		left: () => {
			if (selectedIndex > 0) {
				selectedIndex--;
				return true;
			}
			return false;
		},
		right: () => {
			if (selectedIndex < maxIndex) {
				selectedIndex++;
				return true;
			}
			return false;
		},
		up: () => {
			onUp?.();
			return true;
		},
		down: () => {
			onDown?.();
			return true;
		},
		confirmDown: () => {},
		confirmUp: () => {
			const item = breadcrumbItems[selectedIndex];
			if (item && selectedIndex < breadcrumbItems.length - 1) {
				onNavigate?.(item.path);
			}
		},
		confirmCancel: () => {},
		back: () => {
			// Navigate to parent (second to last item)
			if (breadcrumbItems.length > 1) {
				const parentItem = breadcrumbItems[breadcrumbItems.length - 2];
				onNavigate?.(parentItem.path);
			}
		},
		onActivate: () => {
			selectedIndex = Math.max(0, breadcrumbItems.length - 2);
		},
	};

	onMount(() => {
		setAreaPosition(areaID, { x: 0, y: 1.5 }); // Between breadcrumb (y:1) and content (y:2)
		const unregister = useArea(areaID, areaHandlers);
		return () => {
			unregister();
			removeArea(areaID);
		};
	});

	export function activate() {
		activateArea(areaID);
	}
</script>

<style>
	.breadcrumb {
		flex-wrap: wrap;
		width: 100%;
		padding: 1vh 1.5vh;
		background-color: var(--secondary-background);
		font-size: 2vh;
		box-sizing: border-box;
		display: flex;
		align-items: center;
		gap: 0.5vh;
		border-bottom: 0.2vh solid var(--secondary-softer-background);
	}

	.item {
		color: var(--disabled-foreground);
		padding: 0.2vh 0.6vh;
		border-radius: 0.5vh;
		cursor: pointer;
	}

	.item:hover:not(.current) {
		background-color: var(--secondary-soft-background);
	}

	.item.current {
		color: var(--primary-foreground);
		font-weight: bold;
		cursor: default;
	}

	.item.selected {
		background-color: var(--primary-foreground);
		color: var(--secondary-background);
	}

	.separator {
		color: var(--disabled-foreground);
	}
</style>

<div class="breadcrumb">
	{#each breadcrumbItems as item, index (index)}
		{#if index > 0}
			<span class="separator">&gt;</span>
		{/if}
		<span class="item" class:current={index === breadcrumbItems.length - 1} class:selected={active && selectedIndex === index} onclick={() => index < breadcrumbItems.length - 1 && onNavigate?.(item.path)}>
			{item.name}
		</span>
	{/each}
</div>
