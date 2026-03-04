<script lang="ts">
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { t } from '../../scripts/language.ts';
	import { deleteDownload } from '../../scripts/downloads.ts';
	import Dialog from '../../components/Dialog/Dialog.svelte';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Spinner from '../../components/Spinner/Spinner.svelte';

	interface Props {
		lishID: string;
		lishName?: string | undefined;
		position: Position;
		onResult: (deleteLISH: boolean, success: boolean) => void;
		onBack: () => void;
	}
	let { lishID, lishName, position, onResult, onBack }: Props = $props();

	const options = [
		{ label: $t('common.cancel'), icon: '/img/back.svg', deleteLISH: false, deleteData: false },
		{ label: $t('downloads.deleteDialog.lishOnly'), icon: '/img/del.svg', deleteLISH: true, deleteData: false },
		{ label: $t('downloads.deleteDialog.lishAndData'), icon: '/img/del.svg', deleteLISH: true, deleteData: true },
		{ label: $t('downloads.deleteDialog.dataOnly'), icon: '/img/del.svg', deleteLISH: false, deleteData: true },
	];

	let deleting = $state(false);

	async function handleConfirm(index: number): Promise<void> {
		const option = options[index];
		if (!option) return;
		if (!option.deleteLISH && !option.deleteData) {
			onBack();
			return;
		}
		deleting = true;
		const success = await deleteDownload(lishID, option.deleteLISH, option.deleteData);
		deleting = false;
		onResult(option.deleteLISH, success);
	}

	createNavArea(() => ({
		areaID: 'delete-dialog',
		position,
		activate: true,
		trap: true,
		onBack: () => {
			if (!deleting) onBack();
		},
	}));
</script>

<style>
	.delete-dialog {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 3vh;
	}

	.message {
		font-size: 2vh;
		text-align: center;
		line-height: 1.6;
	}

	.details {
		display: flex;
		flex-direction: column;
		align-items: center;
		font-size: 2vh;
		line-height: 1.6;
	}

	.highlight {
		color: var(--primary-foreground);
	}
</style>

<Dialog title={$t('common.delete')}>
	<div class="delete-dialog">
		{#if deleting}
			<Spinner size="8vh" />
		{:else}
			<div class="message">{$t('downloads.deleteDialog.message')}</div>
			<div class="details">
				<div>LISH ID: <span class="highlight">{lishID}</span></div>
				{#if lishName && lishName !== lishID}
					<div>{$t('common.name')}: <span class="highlight">{lishName}</span></div>
				{/if}
			</div>
			<ButtonBar justify="center" direction="column">
				{#each options as option, index}
					<Button icon={option.icon} label={option.label} position={[0, index]} onConfirm={() => handleConfirm(index)} />
				{/each}
			</ButtonBar>
		{/if}
	</div>
</Dialog>
