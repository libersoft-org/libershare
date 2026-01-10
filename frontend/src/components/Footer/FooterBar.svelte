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
		gap: 0.5vh;
		min-width: 10vh;
	}
</style>

<div class="storage">
	<div class="label">{label}</div>
	<ProgressBar {progress} width="10vh" height="2vh" backgroundColor="var(--secondary-softer-background)" />
</div>
