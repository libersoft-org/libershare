<script lang="ts">
	import Breadcrumb, { type BreadcrumbItem } from '../Breadcrumb/Breadcrumb.svelte';
	import { activateArea } from '../../scripts/areas.ts';
	interface PathBreadcrumbItem extends BreadcrumbItem {
		path: string;
	}
	interface Props {
		areaID: string;
		path: string;
		separator: string;
		onNavigate?: (path: string) => void;
		onUp?: () => void;
		onDown?: () => void;
	}
	let { areaID, path, separator, onNavigate, onUp, onDown }: Props = $props();

	// Parse path into breadcrumb items with their full paths
	let breadcrumbItems = $derived.by<PathBreadcrumbItem[]>(() => {
		if (!path) return [{ id: '0', name: separator === '/' ? '/' : 'Drives', path: '', icon: '/img/storage.svg' }];
		const parts = path.split(separator).filter(Boolean);
		const items: PathBreadcrumbItem[] = [];
		if (separator === '/') {
			// Linux: start with root "/"
			items.push({ id: '0', name: '/', path: '/', icon: '/img/storage.svg' });
			let currentPath = '';
			for (let i = 0; i < parts.length; i++) {
				currentPath += '/' + parts[i];
				items.push({ id: String(i + 1), name: parts[i], path: currentPath });
			}
		} else {
			// Windows: start with drive list, then drive, then folders
			items.push({ id: '0', name: 'Drives', path: '', icon: '/img/storage.svg' });
			let currentPath = '';
			for (let i = 0; i < parts.length; i++) {
				if (i === 0) {
					// Drive letter (e.g., "C:")
					currentPath = parts[i] + separator;
					items.push({ id: String(i + 1), name: parts[i], path: currentPath });
				} else {
					currentPath += parts[i];
					items.push({ id: String(i + 1), name: parts[i], path: currentPath });
					if (i < parts.length - 1) currentPath += separator;
				}
			}
		}
		return items;
	});

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

<Breadcrumb {areaID} items={breadcrumbItems} position={{ x: 0, y: 1.5 }} onSelect={handleSelect} {onUp} {onDown} onBack={handleBack} />
