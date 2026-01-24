<script lang="ts">
	import FileBrowser from '../FileBrowser/FileBrowser.svelte';
	interface Props {
		areaID: string;
		initialPath?: string;
		onSelect?: (path: string) => void;
		onBack?: () => void;
	}
	let { areaID, initialPath = '', onSelect, onBack }: Props = $props();
</script>

<FileBrowser {areaID} {initialPath} foldersOnly showPath {onSelect} {onBack} />
