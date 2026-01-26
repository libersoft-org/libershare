<script lang="ts">
	import type { Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import FileBrowser from '../FileBrowser/FileBrowser.svelte';

	interface Props {
		areaID: string;
		position?: Position;
		onBack?: () => void;
		onSelect?: (path: string) => void;
	}
	let { areaID, position = LAYOUT.content, onBack, onSelect }: Props = $props();

	function handleFileSelect(path: string) {
		onSelect?.(path);
	}
</script>

<FileBrowser areaID="{areaID}-filebrowser" {position} filesOnly fileFilter={['.lish', '.json']} onSelect={handleFileSelect} {onBack} />
