<script lang="ts">
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import FileBrowser from '../FileBrowser/FileBrowser.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		initialPath?: string | undefined;
		onSelect?: ((path: string) => void) | undefined;
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, initialPath = '', onSelect, onBack }: Props = $props();
</script>

<FileBrowser {areaID} {position} {initialPath} foldersOnly showPath selectFolderButton {onSelect} {onBack} />
