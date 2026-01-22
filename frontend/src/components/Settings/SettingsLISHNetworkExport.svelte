<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { useArea, activeArea, activateArea } from '../../scripts/areas.ts';
	import Button from '../Buttons/Button.svelte';
	interface Props {
		areaID: string;
		network?: { id: string; name: string } | null;
		onBack?: () => void;
	}
	let { areaID, network = null, onBack }: Props = $props();
	let active = $derived($activeArea === areaID);

	onMount(() => {
		const unregister = useArea(areaID, {
			up: () => false,
			down: () => false,
			left: () => false,
			right: () => false,
			confirmDown: () => {},
			confirmUp: () => onBack?.(),
			confirmCancel: () => {},
			back: () => onBack?.(),
		});
		activateArea(areaID);
		return unregister;
	});
</script>

<style>
	.export {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		height: 100%;
		padding: 2vh;
		gap: 2vh;
		color: var(--primary-foreground);
	}

	.label {
		font-size: 3vh;
		font-weight: bold;
	}
</style>

<div class="export">
	<div class="label">TODO</div>
	<Button label={$t.common?.back} selected={active} onConfirm={onBack} />
</div>
