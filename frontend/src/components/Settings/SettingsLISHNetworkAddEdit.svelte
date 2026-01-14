<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { useArea, activeArea, activateArea } from '../../scripts/areas.ts';
	import Button from '../Buttons/Button.svelte';
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
	let nameInput: HTMLInputElement;
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
	function handleInputKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			event.preventDefault();
			nameInput?.blur();
		}
	}
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

	.field {
		display: flex;
		flex-direction: column;
		gap: 0.5vh;
	}

	.field .label {
		font-size: 2vh;
		color: var(--disabled-foreground);
	}

	.field input {
		font-size: 2.5vh;
		padding: 1.5vh 2vh;
		border: 0.3vh solid var(--secondary-softer-background);
		border-radius: 1vh;
		background-color: var(--secondary-background);
		color: var(--secondary-foreground);
		outline: none;
		transition: border-color 0.2s;
	}

	.field input:focus {
		border-color: var(--primary-foreground);
	}

	.field.selected input {
		border-color: var(--primary-foreground);
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
		<div class="field" class:selected={active && selectedIndex === 0} bind:this={rowElements[0]}>
			<div class="label">{$t.settings?.lishNetwork?.name ?? 'Name'}</div>
			<input type="text" bind:value={name} bind:this={nameInput} onkeydown={handleInputKeydown} />
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
