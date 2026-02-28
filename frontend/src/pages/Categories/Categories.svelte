<script lang="ts">
	import { onMount } from 'svelte';
	import { useArea, activeArea } from '../../scripts/areas.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { CONTENT_OFFSETS } from '../../scripts/navigationLayout.ts';
	import SearchBar from '../../components/Search/SearchBar.svelte';
	import Menu from '../../components/Menu/Menu.svelte';
	interface Props {
		areaID: string;
		position: Position;
		title: string;
		items: Array<{ id: string; label: string; icon?: string; selected?: boolean; iconPosition?: 'left' | 'top'; iconSize?: string }>;
		orientation?: 'horizontal' | 'vertical';
		selectedId?: string;
		buttonWidth?: string;
		onselect?: (id: string) => void;
		onBack?: () => void;
	}
	let { areaID, position, title, items, orientation = 'horizontal', selectedId, buttonWidth, onselect, onBack }: Props = $props();
	let searchAreaID = $derived(`${areaID}-search`);
	let menuAreaID = $derived(`${areaID}-menu`);
	// Calculate sub-area positions
	let searchPosition = $derived({ x: position.x + CONTENT_OFFSETS.top.x, y: position.y + CONTENT_OFFSETS.top.y });
	let menuPosition = $derived({ x: position.x + CONTENT_OFFSETS.main.x, y: position.y + CONTENT_OFFSETS.main.y });
	let searchSelected = $derived($activeArea === searchAreaID);
	let searchBar: SearchBar;

	onMount(() => {
		// Register search area with position - cleanup is automatic
		const unregisterSearch = useArea(
			searchAreaID,
			{
				up() { return false; },
				down() { return false; },
				confirmUp() { searchBar?.toggleFocus(); },
				back() { onBack?.(); },
			},
			searchPosition
		);

		return unregisterSearch;
	});
</script>

<style>
	.categories {
		display: flex;
		flex-direction: column;
		width: 100%;
		height: 100%;
		box-sizing: border-box;
		overflow: hidden;
	}

	.content {
		display: flex;
		align-items: center;
		justify-content: center;
		flex: 1;
		overflow: hidden;
	}
</style>

<div class="categories">
	<SearchBar bind:this={searchBar} selected={searchSelected} />
	<div class="content">
		<Menu areaID={menuAreaID} position={menuPosition} {title} {items} {orientation} {selectedId} {buttonWidth} {onselect} {onBack} />
	</div>
</div>
