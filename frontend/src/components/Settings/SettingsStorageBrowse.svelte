<script lang="ts">
	import FileBrowser from '../FileBrowser/FileBrowser.svelte';
	import type { Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	interface Props {
		areaID: string;
		position?: Position;
		initialPath?: string;
		onSelect?: (path: string) => void;
		onBack?: () => void;
	}
	let { areaID, position = LAYOUT.content, initialPath = '', onSelect, onBack }: Props = $props();
</script>

<FileBrowser {areaID} {position} {initialPath} foldersOnly showPath {onSelect} {onBack} />
