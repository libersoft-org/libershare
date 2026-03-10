<script lang="ts">
	import { onMount } from 'svelte';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { CONTENT_OFFSETS } from '../../scripts/navigationLayout.ts';
	import { createNavArea, navItem, type NavPos } from '../../scripts/navArea.svelte.ts';
	import SearchBar from '../../components/Search/SearchBar.svelte';
	import ProductsList from './ProductsList.svelte';
	interface Props {
		areaID: string;
		position: Position;
		title?: string;
		category?: string;
		onBack?: () => void;
	}
	let { areaID, position, title = 'Items', onBack }: Props = $props();
	let searchAreaID = $derived(`${areaID}-search`);
	let listAreaID = $derived(`${areaID}-list`);
	let searchPosition = $derived({ x: position.x + CONTENT_OFFSETS.top.x, y: position.y + CONTENT_OFFSETS.top.y });
	let listPosition = $derived({ x: position.x + CONTENT_OFFSETS.main.x, y: position.y + CONTENT_OFFSETS.main.y });
	const items = Array.from({ length: 200 }, (_, i) => ({
		id: i + 1,
		title: 'Item ' + (i + 1),
	}));
	let searchBar: SearchBar | undefined = $state();

	const searchNavHandle = createNavArea(() => ({
		areaID: searchAreaID,
		position: searchPosition,
		onBack,
	}));

	onMount(() => {
		return searchNavHandle.controller.register(
			navItem(
				() => [0, 0] as NavPos,
				() => undefined,
				() => searchBar?.toggleFocus()
			)
		);
	});
</script>

<SearchBar bind:this={searchBar} selected={searchNavHandle.controller.isSelected([0, 0])} />
<ProductsList areaID={listAreaID} position={listPosition} {title} {items} {onBack} />
