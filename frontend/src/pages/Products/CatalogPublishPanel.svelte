<script lang="ts">
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Row from '../../components/Row/Row.svelte';
	import Alert from '../../components/Alert/Alert.svelte';
	import { publishCatalogEntry } from '../../scripts/catalog.ts';
	import { api } from '../../scripts/api.ts';
	import { onMount } from 'svelte';

	interface Props {
		areaID: string;
		position: Position;
		networkID: string;
		onBack?: () => void;
		onPublished?: () => void;
	}
	let { areaID, position, networkID, onBack, onPublished }: Props = $props();

	let publishError = $state('');
	let publishSuccess = $state('');
	let localLISHs = $state<{ id: string; name?: string | undefined }[]>([]);

	const navHandle = createNavArea(() => ({ areaID, position, onBack, activate: true }));

	async function publishLISH(lishID: string, name: string | undefined): Promise<void> {
		publishError = '';
		publishSuccess = '';
		try {
			const detail = await api.lishs.get(lishID);
			if (!detail) { publishError = 'LISH not found'; return; }
			await publishCatalogEntry(networkID, {
				lishID, name: name || lishID, description: detail.description ?? undefined,
				chunkSize: detail.chunkSize, checksumAlgo: detail.checksumAlgo,
				totalSize: detail.totalSize, fileCount: detail.fileCount,
				manifestHash: `sha256:${lishID}`,
			});
			publishSuccess = `Published "${name || lishID}"`;
			onPublished?.();
		} catch (e: any) { publishError = e.message; }
	}

	onMount(() => {
		api.lishs.list().then(r => { localLISHs = r.items.map(l => ({ id: l.id, name: l.name ?? undefined })); }).catch(e => { publishError = e.message; });
	});
</script>

<style>
	.panel {
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
		gap: 2vh;
		width: 1200px;
		max-width: 100%;
	}

	.section-title {
		font-size: 2.5vh;
		font-weight: bold;
		color: var(--secondary-foreground);
		padding: 1vh 0;
	}

	.empty-msg {
		font-size: 1.8vh;
		color: var(--secondary-foreground);
		opacity: 0.5;
		padding: 1vh;
	}

	.lish-name {
		font-size: 2vh;
		color: var(--secondary-foreground);
	}

	.lish-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		width: 100%;
		gap: 2vh;
	}
</style>

<div class="panel">
	<div class="container">
		<ButtonBar>
			<Button icon="/img/back.svg" label="Back" position={[0, 0]} onConfirm={onBack} />
		</ButtonBar>

		{#if publishError}
			<Alert type="error" message={publishError} />
		{/if}
		{#if publishSuccess}
			<Alert type="info" message={publishSuccess} />
		{/if}

		<div class="section-title">Publish LISH to Catalog</div>

		{#if localLISHs.length === 0}
			<div class="empty-msg">No local LISHs found. Create one in Downloads first.</div>
		{:else}
			{#each localLISHs as lish, i}
				<Row selected={navHandle.controller.isYSelected(i + 1)}>
					<div class="lish-row">
						<span class="lish-name">{lish.name || lish.id}</span>
						<Button label="Publish" position={[0, i + 1]} onConfirm={() => publishLISH(lish.id, lish.name)} width="auto" />
					</div>
				</Row>
			{/each}
		{/if}
	</div>
</div>
