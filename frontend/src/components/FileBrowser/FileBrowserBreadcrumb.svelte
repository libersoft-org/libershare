<script lang="ts">
	import Breadcrumb from '../Breadcrumb/Breadcrumb.svelte';
	import type { BreadcrumbItem } from '../../scripts/breadcrumb.ts';
	import { activateArea } from '../../scripts/areas.ts';
	import { type PathBreadcrumbItem, parsePathToBreadcrumbs } from '../../scripts/fileBrowser.ts';
	import type { Position } from '../../scripts/navigationLayout.ts';
	interface Props {
		areaID: string;
		position: Position;
		path: string;
		separator: string;
		onNavigate?: (path: string) => void;
		onDown?: () => string | false;
	}
	let { areaID, position, path, separator, onNavigate, onDown }: Props = $props();

	let breadcrumbItems = $derived(parsePathToBreadcrumbs(path, separator));

	function handleSelect(item: BreadcrumbItem) {
		const pathItem = item as PathBreadcrumbItem;
		onNavigate?.(pathItem.path);
	}

	function handleBack() {
		// Navigate to parent (second to last item)
		if (breadcrumbItems.length > 1) {
			const parentItem = breadcrumbItems[breadcrumbItems.length - 2];
			onNavigate?.(parentItem.path);
		}
	}

	export function activate() {
		activateArea(areaID);
	}
</script>

<Breadcrumb {areaID} items={breadcrumbItems} {position} onSelect={handleSelect} onBack={handleBack} {onDown} />
