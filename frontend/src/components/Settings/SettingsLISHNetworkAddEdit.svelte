<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { useArea, activeArea, activateArea } from '../../scripts/areas.ts';
	import Button from '../Buttons/Button.svelte';
	import Input from '../Input/Input.svelte';
	interface Props {
		areaID: string;
		network?: { id: string; name: string; description?: string; bootstrapServers?: string[] } | null;
		onBack?: () => void;
		onSave?: (network: { id: string; name: string; description: string; bootstrapServers: string[] }) => void;
	}
	let { areaID, network = null, onBack, onSave }: Props = $props();
	let active = $derived($activeArea === areaID);
	let selectedIndex = $state(0);
	let selectedColumn = $state(0); // 0 = input, 1 = remove btn, 2 = add btn
	let rowElements: HTMLElement[] = $state([]);
	let nameInput: Input;
	let descriptionInput: Input;
	let networkIDInput: Input;
	let bootstrapInputs: Input[] = $state([]);
	let name = $state(network?.name ?? '');
	let description = $state(network?.description ?? '');
	let networkID = $state(network?.id || crypto.randomUUID());
	let bootstrapServers = $state<string[]>(network?.bootstrapServers?.length ? [...network.bootstrapServers] : ['']);

	// Dynamic total items: name + description + networkID + bootstrap servers + save + back
	let totalItems = $derived(3 + bootstrapServers.length + 2);

	function handleSave() {
		if (name) {
			onSave?.({
				id: networkID,
				name,
				description,
				bootstrapServers: bootstrapServers.filter(s => s.trim() !== ''),
			});
		}
	}

	function addBootstrapServer() {
		bootstrapServers = [...bootstrapServers, ''];
		// Move to the new input
		selectedIndex = 3 + bootstrapServers.length - 1;
		selectedColumn = 0;
	}

	function removeBootstrapServer(index: number) {
		bootstrapServers = bootstrapServers.filter((_, i) => i !== index);
		// Adjust selectedIndex if needed
		if (selectedIndex > 3 + index) selectedIndex--;
		selectedColumn = 0;
	}

	function getItemType(index: number): { type: 'name' | 'description' | 'networkID' | 'bootstrap' | 'save' | 'back'; bootstrapIndex?: number } {
		if (index === 0) return { type: 'name' };
		if (index === 1) return { type: 'description' };
		if (index === 2) return { type: 'networkID' };
		if (index < 3 + bootstrapServers.length) return { type: 'bootstrap', bootstrapIndex: index - 3 };
		if (index === 3 + bootstrapServers.length) return { type: 'save' };
		return { type: 'back' };
	}

	// Get max column for current bootstrap row
	function getMaxColumn(bootstrapIndex: number): number {
		const isLast = bootstrapIndex === bootstrapServers.length - 1;
		const hasRemove = bootstrapServers.length > 1;
		if (isLast && hasRemove) return 2; // input, remove, add
		if (isLast || hasRemove) return 1; // input + one button
		return 0; // only input
	}

	function focusInput(index: number) {
		const item = getItemType(index);
		if (item.type === 'name' && nameInput) nameInput.focus();
		else if (item.type === 'description' && descriptionInput) descriptionInput.focus();
		else if (item.type === 'networkID' && networkIDInput) networkIDInput.focus();
		else if (item.type === 'bootstrap' && item.bootstrapIndex !== undefined && bootstrapInputs[item.bootstrapIndex]) bootstrapInputs[item.bootstrapIndex].focus();
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
					selectedColumn = 0;
					scrollToSelected();
					return true;
				}
				return false;
			},
			down: () => {
				if (selectedIndex < totalItems - 1) {
					selectedIndex++;
					selectedColumn = 0;
					scrollToSelected();
					return true;
				}
				return false;
			},
			left: () => {
				const item = getItemType(selectedIndex);
				if (item.type === 'bootstrap' && selectedColumn > 0) {
					selectedColumn--;
					return true;
				}
				return false;
			},
			right: () => {
				const item = getItemType(selectedIndex);
				if (item.type === 'bootstrap' && item.bootstrapIndex !== undefined) {
					const maxCol = getMaxColumn(item.bootstrapIndex);
					if (selectedColumn < maxCol) {
						selectedColumn++;
						return true;
					}
				}
				return false;
			},
			confirmDown: () => {},
			confirmUp: () => {
				const item = getItemType(selectedIndex);
				if (item.type === 'name' || item.type === 'description' || item.type === 'networkID') focusInput(selectedIndex);
				else if (item.type === 'bootstrap' && item.bootstrapIndex !== undefined) {
					if (selectedColumn === 0) focusInput(selectedIndex);
					else {
						const isLast = item.bootstrapIndex === bootstrapServers.length - 1;
						const hasRemove = bootstrapServers.length > 1;
						// Determine which button is at current column
						if (hasRemove && selectedColumn === 1) removeBootstrapServer(item.bootstrapIndex);
						else if (isLast && ((hasRemove && selectedColumn === 2) || (!hasRemove && selectedColumn === 1))) addBootstrapServer();
					}
				} else if (item.type === 'save') handleSave();
				else if (item.type === 'back') onBack?.();
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

	.label {
		font-size: 2vh;
		color: var(--disabled-foreground);
		margin-top: 1vh;
	}

	.bootstrap-row {
		display: flex;
		gap: 1vh;
		align-items: flex-end;
	}
</style>

<div class="add-edit">
	<div class="container">
		<div bind:this={rowElements[0]}>
			<Input bind:this={nameInput} bind:value={name} label={$t.settings?.lishNetwork?.name} selected={active && selectedIndex === 0} />
		</div>
		<div bind:this={rowElements[1]}>
			<Input bind:this={descriptionInput} bind:value={description} label={$t.settings?.lishNetwork?.description} multiline rows={4} selected={active && selectedIndex === 1} />
		</div>
		<div bind:this={rowElements[2]}>
			<Input bind:this={networkIDInput} bind:value={networkID} label={$t.settings?.lishNetwork?.networkID} selected={active && selectedIndex === 2} />
		</div>
		<div class="label">{$t.settings?.lishNetwork?.bootstrapServers}:</div>
		{#each bootstrapServers as server, index (index)}
			{@const isLast = index === bootstrapServers.length - 1}
			{@const hasRemove = bootstrapServers.length > 1}
			{@const isRowSelected = active && selectedIndex === 3 + index}
			<div class="bootstrap-row" bind:this={rowElements[3 + index]}>
				<Input bind:this={bootstrapInputs[index]} bind:value={bootstrapServers[index]} placeholder="address:port" selected={isRowSelected && selectedColumn === 0} flex />
				{#if hasRemove}
					<Button icon="/img/del.svg" selected={isRowSelected && selectedColumn === 1} onConfirm={() => removeBootstrapServer(index)} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
				{/if}
				{#if isLast}
					<Button icon="/img/add.svg" selected={isRowSelected && ((hasRemove && selectedColumn === 2) || (!hasRemove && selectedColumn === 1))} onConfirm={() => addBootstrapServer()} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
				{/if}
			</div>
		{/each}
	</div>
	<div class="buttons">
		<div bind:this={rowElements[3 + bootstrapServers.length]}>
			<Button label={$t.common?.save} selected={active && selectedIndex === 3 + bootstrapServers.length} onConfirm={handleSave} />
		</div>
		<div bind:this={rowElements[3 + bootstrapServers.length + 1]}>
			<Button label={$t.common?.back} selected={active && selectedIndex === 3 + bootstrapServers.length + 1} onConfirm={onBack} />
		</div>
	</div>
</div>
