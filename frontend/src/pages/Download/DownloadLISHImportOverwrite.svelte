<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { type ILISH, type LISHNetworkConfig } from '@shared';
	import { api } from '../../scripts/api.ts';
	import { getNetworks } from '../../scripts/lishNetwork.ts';
	import ChoiceDialog from '../../components/Dialog/ChoiceDialog.svelte';
	import ConfirmDialog from '../../components/Dialog/ConfirmDialog.svelte';
	import Dialog from '../../components/Dialog/Dialog.svelte';
	import Spinner from '../../components/Spinner/Spinner.svelte';
	interface Props {
		lishs: ILISH[];
		downloadPath: string;
		position: Position;
		enableSharing?: boolean | undefined;
		enableDownloading?: boolean | undefined;
		onDone: () => void;
		onError: (error: unknown) => void;
	}
	let { lishs, downloadPath, position, enableSharing, enableDownloading, onDone, onError }: Props = $props();
	let overwriteQueue = $state<ILISH[]>([]);
	let newLISHs = $state<ILISH[]>([]);
	let processing = $state(true);
	let currentOverwriteLISH = $derived(overwriteQueue.length > 0 ? overwriteQueue[0] : null);
	// Where the imported LISHs are shared, asked when protected lishnets are joined: imported without a choice they
	// were always public. Undefined (no protected lishnet, nothing asked) keeps a known LISH's scope and makes a new one public.
	let protectedNets = $state<LISHNetworkConfig[]>([]);
	let scopeOptions = $state<Array<{ value: string; label: string; icon?: string }>>([]);
	let scopeInitial = $state(0);
	let choosingScope = $state(false);
	let scope: string[] | undefined;

	async function runImport(operation: () => Promise<void>): Promise<void> {
		processing = true;
		try {
			await operation();
		} catch (error) {
			onError(error);
		} finally {
			processing = false;
		}
	}

	async function processLISHs(): Promise<void> {
		const toConfirm: ILISH[] = [];
		const toAdd: ILISH[] = [];
		for (const lish of lishs) {
			const existing = await api.lishs.get(lish.id);
			if (existing) toConfirm.push(lish);
			else toAdd.push(lish);
		}
		newLISHs = toAdd;
		if (toConfirm.length > 0) {
			overwriteQueue = toConfirm;
		} else await finishImport();
	}

	async function confirmOverwrite(): Promise<void> {
		if (currentOverwriteLISH) {
			await api.lishs.importFromJSON(JSON.stringify(currentOverwriteLISH), downloadPath, true, enableSharing, enableDownloading, scope);
			overwriteQueue = overwriteQueue.slice(1);
		}
		if (overwriteQueue.length === 0) await finishImport();
	}

	async function skipOverwrite(): Promise<void> {
		overwriteQueue = overwriteQueue.slice(1);
		if (overwriteQueue.length === 0) await finishImport();
	}

	async function finishImport(): Promise<void> {
		for (const lish of newLISHs) {
			await api.lishs.importFromJSON(JSON.stringify(lish), downloadPath, undefined, enableSharing, enableDownloading, scope);
		}
		newLISHs = [];
		onDone();
	}

	onMount(() => {
		void (async () => {
			let nets: LISHNetworkConfig[];
			try {
				nets = await getNetworks();
			} catch (error) {
				// Unknown lishnets are no answer to where the LISHs go: taken as none, the import shared them publicly.
				onError(error);
				return;
			}
			protectedNets = nets.filter(n => n.overlay);
			if (protectedNets.length === 0) return runImport(processLISHs);
			const hasPublic = nets.some(n => !n.overlay && n.enabled);
			scopeOptions = [...(hasPublic ? [{ value: '', label: $t('lish.create.sharePublic') }] : []), ...protectedNets.map(n => ({ value: n.networkID, label: n.name, icon: '/img/lock.svg' }))];
			scopeInitial = 0;
			processing = false;
			choosingScope = true;
		})();
	});

	function chooseScope(value: string): void {
		scope = value ? [value] : undefined;
		choosingScope = false;
		void runImport(processLISHs);
	}
</script>

<style>
	.loading {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 3vh;
		padding: 2vh 4vh;
	}

	.label {
		font-size: 2vh;
		text-align: center;
	}
</style>

{#if choosingScope}
	<ChoiceDialog title={$t('common.import')} message={$t('lish.create.shareIn') + ':'} options={scopeOptions} initial={scopeInitial} {position} onChoose={chooseScope} onBack={() => onDone()} />
{:else if processing}
	<Dialog title={$t('common.import')}>
		<div class="loading">
			<Spinner size="8vh" />
			<div class="label">{$t('import.importing')}</div>
		</div>
	</Dialog>
{:else if currentOverwriteLISH}
	<ConfirmDialog title={$t('common.import')} message={$t('lish.import.confirmOverwrite', { name: currentOverwriteLISH.name || currentOverwriteLISH.id, id: currentOverwriteLISH.id })} confirmLabel={$t('common.yes')} cancelLabel={$t('common.no')} confirmIcon="/img/check.svg" cancelIcon="/img/cross.svg" {position} onConfirm={() => runImport(confirmOverwrite)} onBack={() => runImport(skipOverwrite)} />
{/if}
