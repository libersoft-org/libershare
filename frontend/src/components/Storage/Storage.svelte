<script lang="ts">
	import FileBrowser from '../FileBrowser/FileBrowser.svelte';
	import { storagePath } from '../../scripts/settings.ts';
	interface Props {
		areaID: string;
		title?: string;
		onBack?: () => void;
	}
	let { areaID, title = 'Storage', onBack }: Props = $props();
</script>

<FileBrowser {areaID} {onBack} initialPath={$storagePath} />
