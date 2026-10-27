<script lang="ts">
	import { onMount } from 'svelte';
	import { t, translateError } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { type ILISHFileInspection } from '@shared';
	import { api } from '../../scripts/api.ts';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Alert from '../../components/Alert/Alert.svelte';
	import Spinner from '../../components/Spinner/Spinner.svelte';
	import NetworkLishDetailView from '../Network/NetworkLishDetailView.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		/** The .lish / .lishs file opened in the file browser. */
		filePath: string;
		onBack?: (() => void) | undefined;
		/** Continue to the import dialog for the same file. */
		onImport: () => void;
	}
	let { areaID, position = LAYOUT.content, filePath, onBack, onImport }: Props = $props();
	let items = $state<ILISHFileInspection[]>([]);
	let loading = $state(true);
	let error = $state('');
	// The import refuses a file with any invalid manifest, after importing the ones before it.
	let importable = $derived(items.length > 0 && items.every(item => !item.error));

	function itemError(item: ILISHFileInspection): string {
		return translateError(Object.assign(new Error(item.error ?? ''), { code: item.error, detail: item.errorDetail }));
	}

	async function load(): Promise<void> {
		loading = true;
		error = '';
		try {
			items = await api.lishs.inspectFile(filePath);
		} catch (e: any) {
			error = translateError(e);
			items = [];
		}
		loading = false;
	}

	createNavArea(() => ({ areaID, position, onBack, activate: true }));

	onMount(() => {
		load();
	});
</script>

<style>
	.lish-info {
		display: flex;
		flex-direction: column;
		align-items: center;
		flex: 1;
		min-height: 0;
		padding: 2vh;
		gap: 2vh;
		overflow-y: auto;
	}

	.container {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 2vh;
		width: 1200px;
		max-width: calc(94vw);
		padding: 2vh;
		border-radius: 2vh;
		box-sizing: border-box;
		background-color: var(--secondary-background);
		box-shadow: 0 0 2vh var(--secondary-background);
	}

	@media (max-width: 1199px) {
		.container {
			max-width: calc(100vw);
			margin: 0;
			border-radius: 0;
			box-shadow: none;
		}
	}
</style>

<div class="lish-info">
	<div class="container">
		<ButtonBar basePosition={[0, 0]}>
			<Button icon="/img/back.svg" label={$t('common.back')} onConfirm={onBack} width="auto" />
			{#if importable}
				<Button icon="/img/download.svg" label={$t('common.import')} onConfirm={onImport} width="auto" />
			{/if}
		</ButtonBar>
		{#if loading}
			<Spinner size="8vh" />
		{:else if error}
			<Alert type="error" message={error} />
		{:else if items.length === 0}
			<Alert type="warning" message={$t('lish.fileEmpty')} />
		{:else}
			{#each items as item, i (i)}
				{#if item.error}
					<Alert type="error" message={itemError(item)} />
				{/if}
				{#if item.detail}
					<NetworkLishDetailView detail={item.detail} fileRowsBaseY={items.length === 1 ? 1 : undefined} />
				{/if}
			{/each}
		{/if}
	</div>
</div>
