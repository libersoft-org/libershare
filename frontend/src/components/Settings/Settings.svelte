<script lang="ts">
	import ButtonsGroup from '../Buttons/ButtonsGroup.svelte';
	import Button from '../Buttons/Button.svelte';
	interface Props {
		areaID: string;
		onBack?: () => void;
	}
	let { areaID, onBack }: Props = $props();
</script>

<style>
	.settings {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 2vh;
		height: 100%;
	}
</style>

<div class="settings">
	<ButtonsGroup {areaID} {onBack}>
		<Button label="Language" onConfirm={() => {}} />
		<Button label="Back" onConfirm={onBack} />
	</ButtonsGroup>
</div>
