<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { useArea, activeArea, activateArea } from '../../scripts/areas.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { CONTENT_POSITIONS } from '../../scripts/navigationLayout.ts';
	import Button from '../../components/Buttons/Button.svelte';
	import Input from '../../components/Input/Input.svelte';
	import Alert from '../../components/Alert/Alert.svelte';
	interface Props {
		areaID: string;
		position?: Position;
		onBack?: () => void;
	}
	let { areaID, position = CONTENT_POSITIONS.main, onBack }: Props = $props();
	let active = $derived($activeArea === areaID);
	// TODO: Get all LISH from storage/backend
	let lishList: unknown[] = $state([]);
	let hasLish = $derived(lishList.length > 0);
	let selectedIndex = $state(0); // 0 = input (if has lish), 1 = buttons row
	let selectedColumn = $state(0); // 0 = save as, 1 = back
	let inputRef: Input | undefined = $state();

	let lishJson = $derived(JSON.stringify(lishList, null, '\t'));

	onMount(() => {
		const unregister = useArea(
			areaID,
			{
				up: () => {
					if (hasLish && selectedIndex > 0) {
						selectedIndex--;
						return true;
					}
					return false;
				},
				down: () => {
					if (hasLish && selectedIndex < 1) {
						selectedIndex++;
						selectedColumn = 0;
						return true;
					}
					return false;
				},
				left: () => {
					if (selectedIndex === 1 && selectedColumn > 0) {
						selectedColumn--;
						return true;
					}
					return false;
				},
				right: () => {
					if (selectedIndex === 1 && selectedColumn < 1) {
						selectedColumn++;
						return true;
					}
					return false;
				},
				confirmDown: () => {
					if (hasLish && selectedIndex === 0) inputRef?.focus();
				},
				confirmUp: () => {
					if (hasLish && selectedIndex === 1 && selectedColumn === 1) onBack?.();
					else if (!hasLish) onBack?.();
				},
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
	.export-all {
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

<div class="export-all">
	<div class="container">
		{#if hasLish}
			<Input bind:this={inputRef} value={lishJson} multiline rows={15} readonly fontSize="2vh" fontFamily="'Ubuntu Mono'" selected={active && selectedIndex === 0} />
		{:else}
			<Alert type="warning" message={$t('downloads.emptyList')} />
		{/if}
	</div>
	<div class="buttons">
		{#if hasLish}
			<Button icon="/img/save.svg" label="{$t('common.saveAs')} ..." selected={active && selectedIndex === 1 && selectedColumn === 0} />
		{/if}
		<Button icon="/img/back.svg" label={$t('common.back')} selected={active && (hasLish ? selectedIndex === 1 && selectedColumn === 1 : true)} onConfirm={onBack} />
	</div>
</div>
