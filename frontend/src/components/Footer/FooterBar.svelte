<script lang="ts">
	import ProgressBar from '../ProgressBar/ProgressBar.svelte';

	interface Props {
		label: string;
		progress: number;
	}

	const { label, progress }: Props = $props();
</script>

<style>
	.storage {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.3vh;
		min-width: 10vh;
	}

	.progress {
		width: 100%;
	}
</style>

<div class="storage">
	<div class="label">{label}</div>
	<div class="progress">
		<ProgressBar {progress} height="2vh" />
	</div>
</div>
