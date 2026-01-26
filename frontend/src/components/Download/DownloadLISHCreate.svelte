<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { useArea, activeArea, activateArea } from '../../scripts/areas.ts';
	import type { Position } from '../../scripts/navigationLayout.ts';
	import { CONTENT_POSITIONS } from '../../scripts/navigationLayout.ts';
	import Alert from '../Alert/Alert.svelte';
	import Button from '../Buttons/Button.svelte';
	interface Props {
		areaID: string;
		position?: Position;
		onBack?: () => void;
	}
	let { areaID, position = CONTENT_POSITIONS.main, onBack }: Props = $props();
	let active = $derived($activeArea === areaID);

	onMount(() => {
		const unregister = useArea(
			areaID,
			{
				up: () => false,
				down: () => false,
				left: () => false,
				right: () => false,
				confirmDown: () => {},
				confirmUp: () => onBack?.(),
				confirmCancel: () => {},
				back: () => onBack?.(),
			},
			position
		);
		activateArea(areaID);
		return unregister;
	});
</script>

<style>
	.create {
		display: flex;
		flex-direction: column;
		align-items: center;
		height: 100%;
		padding: 2vh;
		gap: 2vh;
	}

	.container {
		display: flex;
		flex-direction: column;
		gap: 1vh;
		width: 800px;
		max-width: 100%;
	}

	.buttons {
		display: flex;
		justify-content: center;
		gap: 2vh;
	}
</style>

<div class="create">
	<div class="container">
		<Alert type="info" message="Not yet implemented" />
	</div>
	<div class="buttons">
		<Button icon="/img/back.svg" label={$t.common?.back} selected={active} onConfirm={onBack} />
	</div>
</div>
