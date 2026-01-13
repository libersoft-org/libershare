<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { useArea, activeArea } from '../../scripts/areas.ts';
	import Button from '../Buttons/Button.svelte';
	import Row from '../Row/Row.svelte';
	interface Props {
		areaID: string;
		onBack?: () => void;
	}
	let { areaID, onBack }: Props = $props();
	let active = $derived($activeArea === areaID);
	let selectedIndex = $state(0);
	let storagePath = $state('/downloads/');
	let rowElements: HTMLElement[] = $state([]);
	const totalItems = 2; // 0 = path row, 1 = back button

	function changeStoragePath() {
		// TODO: Open download folder selection dialog
		console.log('Change storage path');
	}

	onMount(() => {
		return useArea(areaID, {
			up: () => {
				if (selectedIndex > 0) {
					selectedIndex--;
					scrollToSelected();
					return true;
				}
				return false;
			},
			down: () => {
				if (selectedIndex < totalItems - 1) {
					selectedIndex++;
					scrollToSelected();
					return true;
				}
				return false;
			},
			left: () => false,
			right: () => false,
			confirmDown: () => {},
			confirmUp: () => {
				if (selectedIndex === 0) changeStoragePath();
				else if (selectedIndex === totalItems - 1) onBack?.();
			},
			confirmCancel: () => {},
			back: () => onBack?.(),
		});
	});

	function scrollToSelected(): void {
		const element = rowElements[selectedIndex];
		if (element) {
			element.scrollIntoView({
				behavior: 'smooth',
				block: 'center',
			});
		}
	}
</script>

<style>
	.storage {
		display: flex;
		flex-direction: column;
		align-items: center;
		height: 100%;
		padding: 2vh;
		gap: 2vh;
		overflow-y: auto;
	}

	.rows {
		width: 1000px;
		max-width: 100%;
	}

	.info {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.5vh;
	}

	.info .label {
		font-size: 2vh;
		color: var(--disabled-foreground);
	}

	.info .path {
		font-size: 3vh;
		font-weight: bold;
		color: var(--secondary-foreground);
	}

	.back {
		margin-top: 2vh;
	}
</style>

<div class="storage">
	<div class="rows" bind:this={rowElements[0]}>
		<Row selected={active && selectedIndex === 0}>
			<div class="info">
				<div class="label">{$t.settings?.storage?.folderDownload}</div>
				<div class="path">{storagePath}</div>
			</div>
			<Button label={$t.common?.change} selected={active && selectedIndex === 0} onConfirm={changeStoragePath} />
		</Row>
	</div>
	<div class="back" bind:this={rowElements[totalItems - 1]}>
		<Button label={$t.common?.back} selected={active && selectedIndex === totalItems - 1} onConfirm={onBack} />
	</div>
</div>
