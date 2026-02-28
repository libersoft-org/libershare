<script lang="ts">
	import { tick } from 'svelte';
	import { type BreadcrumbItem } from '../../scripts/breadcrumb.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import Breadcrumb from './Breadcrumb.svelte';
	interface Props {
		areaID: string;
		position: Position;
		items: string[];
		onBack?: (() => void) | undefined;
	}
	let { areaID, position, items, onBack }: Props = $props();
	// Convert string items to BreadcrumbItem format
	// First item (Domů/Home) gets an icon instead of text
	let breadcrumbItems = $derived<BreadcrumbItem[]>(
		items.map((name, index) => ({
			id: String(index),
			name,
			icon: index === 0 ? '/img/home.svg' : undefined,
		}))
	);

	async function handleSelect(_item: BreadcrumbItem, index: number): Promise<void> {
		// Navigate to the selected breadcrumb level by calling onBack multiple times
		const stepsBack = items.length - 1 - index;
		for (let i = 0; i < stepsBack; i++) {
			onBack?.();
			await tick();
		}
	}
</script>

<Breadcrumb {areaID} {position} items={breadcrumbItems} onSelect={handleSelect} {onBack} />
