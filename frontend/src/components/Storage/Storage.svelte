<script lang="ts">
	import FileBrowser from '../FileBrowser/FileBrowser.svelte';
	import { storagePath } from '../../scripts/settings.ts';
	import type { Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	interface Props {
		areaID: string;
		position?: Position;
		onBack?: () => void;
	}
	let { areaID, position = LAYOUT.content, onBack }: Props = $props();
</script>

<FileBrowser {areaID} {position} {onBack} initialPath={$storagePath} />
