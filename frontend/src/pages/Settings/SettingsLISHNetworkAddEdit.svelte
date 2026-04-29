<script lang="ts">
	import { untrack } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { type NetworkFormData } from '../../scripts/lishNetwork.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import Alert from '../../components/Alert/Alert.svelte';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Input from '../../components/Input/Input.svelte';
	import SwitchRow from '../../components/Switch/SwitchRow.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		network?: NetworkFormData | null | undefined;
		onBack?: (() => void) | undefined;
		onSave?: ((network: NetworkFormData) => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, network = null, onBack, onSave }: Props = $props();
	let name = $state(untrack(() => network?.name ?? ''));
	let description = $state(untrack(() => network?.description ?? ''));
	let isEditing = $derived(network !== null);
	let autoGenerateID = $state(untrack(() => !network));
	let networkID = $state(untrack(() => network?.id ?? ''));
	let bootstrapServers = $state<string[]>(untrack(() => (network?.bootstrapServers?.length ? [...network.bootstrapServers] : [''])));
	let submitted = $state(false);
	let errorMessage = $derived(!name.trim() ? $t('settings.lishNetwork.errorNameRequired') : !autoGenerateID && !networkID.trim() ? $t('settings.lishNetwork.errorNetworkIDRequired') : '');
	let showError = $derived(submitted && errorMessage);
	let bootstrapOffset = $derived(isEditing ? 3 : 4);

	function handleSave(): void {
		submitted = true;
		if (!errorMessage) {
			onSave?.({
				id: autoGenerateID ? '' : networkID,
				name,
				description,
				bootstrapServers: bootstrapServers.filter(s => s.trim() !== ''),
			});
		}
	}

	function addBootstrapServer(): void {
		bootstrapServers = [...bootstrapServers, ''];
	}

	function removeBootstrapServer(index: number): void {
		bootstrapServers = bootstrapServers.filter((_, i) => i !== index);
	}

	function toggleAutoGenerateID(): void {
		autoGenerateID = !autoGenerateID;
		if (autoGenerateID) networkID = '';
	}

	createNavArea(() => ({ areaID, position, onBack, activate: true }));
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
		<div role="group" data-mouse-activate-area={areaID}>
			<Input bind:value={name} label={$t('common.name')} position={[0, 0]} />
		</div>
		<div role="group" data-mouse-activate-area={areaID}>
			<Input bind:value={description} label={$t('common.description')} multiline rows={4} position={[0, 1]} />
		</div>
		{#if !isEditing}
			<div role="group" data-mouse-activate-area={areaID}>
				<SwitchRow label={$t('settings.lishNetwork.autoGenerate') + ':'} checked={autoGenerateID} position={[0, 2]} onToggle={toggleAutoGenerateID} />
			</div>
			{#key autoGenerateID}
				<div role="group" data-mouse-activate-area={areaID}>
					<Input bind:value={networkID} label={$t('settings.lishNetwork.networkID')} position={autoGenerateID ? undefined : [0, 3]} disabled={autoGenerateID} />
				</div>
			{/key}
		{:else}
			<div role="group" data-mouse-activate-area={areaID}>
				<Input bind:value={networkID} label={$t('settings.lishNetwork.networkID')} position={[0, 2]} />
			</div>
		{/if}
		<div class="label">{$t('settings.lishNetwork.bootstrapServers')}:</div>
		{#each bootstrapServers as _server, index (index)}
			{@const isLast = index === bootstrapServers.length - 1}
			{@const hasRemove = bootstrapServers.length > 1}
			<div class="bootstrap-row" role="group" data-mouse-activate-area={areaID}>
				<Input bind:value={bootstrapServers[index]} placeholder="address:port" position={[0, bootstrapOffset + index]} flex />
				{#if hasRemove}
					<Button icon="/img/minus.svg" position={[1, bootstrapOffset + index]} onConfirm={() => removeBootstrapServer(index)} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
				{/if}
				{#if isLast}
					<Button icon="/img/plus.svg" position={hasRemove ? [2, bootstrapOffset + index] : [1, bootstrapOffset + index]} onConfirm={() => addBootstrapServer()} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
				{/if}
			</div>
		{/each}
		<Alert type="error" message={showError ? errorMessage : ''} />
	</div>
	<ButtonBar justify="center" basePosition={[0, bootstrapOffset + bootstrapServers.length]}>
		<Button icon="/img/save.svg" label={$t('common.save')} onConfirm={handleSave} />
		<Button icon="/img/back.svg" label={$t('common.back')} onConfirm={onBack} />
	</ButtonBar>
</div>
