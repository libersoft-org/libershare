<script lang="ts">
	import FileBrowser from '../FileBrowser/FileBrowser.svelte';
	import { storagePath } from '../../scripts/settings.ts';
	import { activateArea } from '../../scripts/areas.ts';
	interface Props {
		areaID: string;
		onBack?: () => void;
	}
	let { areaID, onBack }: Props = $props();
</script>

<FileBrowser {areaID} {onBack} initialPath={$storagePath} onUpAtStart={() => activateArea('breadcrumb')} />
