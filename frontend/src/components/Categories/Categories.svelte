<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { useArea, setAreaPosition, removeArea, activateArea, activeArea } from '../../scripts/areas.ts';
	import SearchBar from '../Search/SearchBar.svelte';
	import Menu from '../Menu/Menu.svelte';
	interface Props {
		areaID: string;
		title: string;
		items: Array<{ id: string; label: string; selected?: boolean }>;
		orientation?: 'horizontal' | 'vertical';
		selectedId?: string;
		buttonWidth?: string;
		onselect?: (id: string) => void;
		onBack?: () => void;
	}
	let { areaID, title, items, orientation = 'horizontal', selectedId, buttonWidth, onselect, onBack }: Props = $props();
	const searchAreaID = `${areaID}-search`;
	const menuAreaID = `${areaID}-menu`;
	let searchSelected = $derived($activeArea === searchAreaID);
	let searchBar: SearchBar;

	onMount(() => {
		// Position search between breadcrumb (y=1) and content/menu (y=2)
		setAreaPosition(searchAreaID, { x: 0, y: 1.5 });
		// Position menu at content level
		setAreaPosition(menuAreaID, { x: 0, y: 2 });
		// Register search area handlers
		const unregisterSearch = useArea(searchAreaID, {
			up: () => {
				// Navigate to breadcrumb manually (areaNavigate looks for y-1 which won't find y=1 from y=1.5)
				activateArea('breadcrumb');
				return true;
			},
			down: () => {
				activateArea(menuAreaID);
				return true;
			},
			confirmUp: () => {
				searchBar?.toggleFocus();
			},
			back: () => onBack?.(),
		});
		return () => {
			unregisterSearch();
			removeArea(searchAreaID);
			removeArea(menuAreaID);
		};
	});

	function handleMenuUp() {
		activateArea(searchAreaID);
	}
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
		<Menu areaID={menuAreaID} {title} {items} {orientation} {selectedId} {buttonWidth} {onselect} {onBack} onUp={handleMenuUp} />
	</div>
</div>
