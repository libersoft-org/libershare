<script lang="ts">
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { api } from '../../scripts/api.ts';
	import { type IdentityBackup } from '@shared';
	import ImportWebForm from '../../components/Import/ImportWebForm.svelte';
	import SettingsIdentityImportConfirm from './SettingsIdentityImportConfirm.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		onBack?: (() => void) | undefined;
		onImport?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, onBack, onImport }: Props = $props();
	let currentPeerID = $state('');

	async function parseURL(url: string): Promise<IdentityBackup> {
		const cur = await api.identity.get();
		currentPeerID = cur.peerID;
		return await api.identity.parseFromURL(url);
	}

	function handleConfirmDone(): void {
		onImport?.();
		onBack?.();
		onBack?.();
	}
</script>

<ImportWebForm {areaID} {position} {onBack} {parseURL} onConfirmDone={handleConfirmDone}>
	{#snippet confirm({ data, onDone })}
		<SettingsIdentityImportConfirm data={data as IdentityBackup} {currentPeerID} {position} {onDone} />
	{/snippet}
</ImportWebForm>
