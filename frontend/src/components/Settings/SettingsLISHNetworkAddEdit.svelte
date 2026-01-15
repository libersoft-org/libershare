<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { useArea, activeArea, activateArea } from '../../scripts/areas.ts';
	import Button from '../Buttons/Button.svelte';
	import Input from '../Input/Input.svelte';
	interface Props {
		areaID: string;
		network?: { id: string; name: string } | null;
		onBack?: () => void;
		onSave?: (network: { id: string; name: string }) => void;
	}
	let { areaID, network = null, onBack, onSave }: Props = $props();
	let active = $derived($activeArea === areaID);
	let selectedIndex = $state(0);
	let rowElements: HTMLElement[] = $state([]);
	let nameInput: Input;
	let name = $state(network?.name ?? '');
	const totalItems = 3; // 0 = name, 1 = save, 2 = back

	function handleSave() {
		if (name) {
			onSave?.({
				id: network?.id ?? '',
				name,
			});
		}
	}

	function focusInput(index: number) {
		if (index === 0 && nameInput) nameInput.focus();
	}

	function scrollToSelected(): void {
		const element = rowElements[selectedIndex];
		if (element) {
			element.scrollIntoView({
				behavior: 'smooth',
				block: 'center',
			});
		}
	}

	onMount(() => {
		const unregister = useArea(areaID, {
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
				if (selectedIndex === 0) focusInput(0);
				else if (selectedIndex === 1) handleSave();
				else if (selectedIndex === 2) onBack?.();
			},
			confirmCancel: () => {},
			back: () => onBack?.(),
		});
		// Activate this area
		activateArea(areaID);
		return unregister;
	});
</script>

<style>
	.add-edit {
		display: flex;
		flex-direction: column;
		align-items: center;
		height: 100%;
		padding: 2vh;
		gap: 2vh;
		overflow-y: auto;
	}

	.container {
		display: flex;
		flex-direction: column;
		gap: 1vh;
		width: 1000px;
		max-width: 100%;
	}

	.buttons {
		display: flex;
		justify-content: center;
		gap: 2vh;
		margin-top: 2vh;
	}
</style>

<div class="add-edit">
	<div class="container">
		<div bind:this={rowElements[0]}>
			<Input bind:this={nameInput} bind:value={name} label={$t.settings?.lishNetwork?.name ?? 'Name'} selected={active && selectedIndex === 0} />
		</div>
	</div>
	<div class="buttons">
		<div bind:this={rowElements[1]}>
			<Button label={$t.common?.save ?? 'Save'} selected={active && selectedIndex === 1} onConfirm={handleSave} />
		</div>
		<div bind:this={rowElements[2]}>
			<Button label={$t.common?.back ?? 'Back'} selected={active && selectedIndex === 2} onConfirm={onBack} />
		</div>
	</div>
</div>
