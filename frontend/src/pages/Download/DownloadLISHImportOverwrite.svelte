<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { type ILISH } from '@shared';
	import { api } from '../../scripts/api.ts';
	import { unverifiedOffer, type UnverifiedOffer } from '../../scripts/lishVerification.ts';
	import { answerUnverifiedOffers } from '../../scripts/lishUnverifiedAnswer.ts';
	import ConfirmDialog from '../../components/Dialog/ConfirmDialog.svelte';
	import UnverifiedLISHDialog from '../../components/Dialog/UnverifiedLISHDialog.svelte';
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
	/** A LISH that is not verified, kept with what was sent for it until the user answers. */
	interface HeldImport {
		offer: UnverifiedOffer;
		lish: ILISH;
		overwrite: boolean | undefined;
	}
	let held = $state.raw<HeldImport[]>([]);
	let processing = $state(true);
	let currentOverwriteLISH = $derived(overwriteQueue.length > 0 ? overwriteQueue[0] : null);
	// One answer covers every unsigned LISH; one whose signature or ID failed a check is asked about on its own.
	let question = $derived.by<HeldImport[]>(() => {
		const unsigned = held.filter(item => item.offer.code === 'LISH_UNSIGNED');
		return unsigned.length > 0 ? unsigned : held.slice(0, 1);
	});

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

	async function importOne(lish: ILISH, overwrite?: boolean, acceptUnverified?: boolean): Promise<void> {
		try {
			await api.lishs.importFromJSON(JSON.stringify(lish), downloadPath, overwrite, enableSharing, enableDownloading, acceptUnverified);
		} catch (error) {
			const offer = unverifiedOffer(error, lish);
			if (!offer || acceptUnverified) throw error;
			held = [...held, { offer, lish, overwrite }];
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
			await importOne(currentOverwriteLISH, true);
			overwriteQueue = overwriteQueue.slice(1);
		}
		if (overwriteQueue.length === 0) await finishImport();
	}

	async function skipOverwrite(): Promise<void> {
		overwriteQueue = overwriteQueue.slice(1);
		if (overwriteQueue.length === 0) await finishImport();
	}

	async function finishImport(): Promise<void> {
		for (const lish of newLISHs) await importOne(lish);
		newLISHs = [];
		if (held.length === 0) onDone();
	}

	async function answerQuestion(accept: boolean): Promise<void> {
		const answered = question;
		held = held.filter(item => !answered.includes(item));
		// Agreeing sends the same manifest again instead of naming the one the backend holds: it
		// keeps only so many waiting and only for a while, and a backup can carry more than that.
		if (accept) for (const item of answered) await importOne(item.lish, item.overwrite, true);
		else
			await answerUnverifiedOffers(
				answered.map(item => item.offer),
				false
			);
		if (held.length === 0) onDone();
	}

	onMount(() => {
		void runImport(processLISHs);
	});
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

{#if processing}
	<Dialog title={$t('common.import')}>
		<div class="loading">
			<Spinner size="8vh" />
			<div class="label">{$t('import.importing')}</div>
		</div>
	</Dialog>
{:else if currentOverwriteLISH}
	<ConfirmDialog title={$t('common.import')} message={$t('lish.import.confirmOverwrite', { name: currentOverwriteLISH.name || currentOverwriteLISH.id, id: currentOverwriteLISH.id })} confirmLabel={$t('common.yes')} cancelLabel={$t('common.no')} confirmIcon="/img/check.svg" cancelIcon="/img/cross.svg" {position} onConfirm={() => runImport(confirmOverwrite)} onBack={() => runImport(skipOverwrite)} />
{:else if question[0]}
	<UnverifiedLISHDialog offer={question[0].offer} message={question.length > 1 ? $t('lish.unverified.askManyUnsigned', { count: String(question.length) }) : undefined} {position} onAccept={() => runImport(() => answerQuestion(true))} onRefuse={() => runImport(() => answerQuestion(false))} />
{/if}
