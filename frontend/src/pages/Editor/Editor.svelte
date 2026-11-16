<script lang="ts">
	import { onMount } from 'svelte';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { CONTENT_OFFSETS } from '../../scripts/navigationLayout.ts';
	import { createNavArea, type NavPos } from '../../scripts/navArea.svelte.ts';
	import { api } from '../../scripts/api.ts';
	import { t, translateError } from '../../scripts/language.ts';
	import { addNotification } from '../../scripts/notifications.ts';
	import Button from '../../components/Buttons/Button.svelte';
	import Input from '../../components/Input/Input.svelte';
	import Spinner from '../../components/Spinner/Spinner.svelte';
	import Alert from '../../components/Alert/Alert.svelte';
	interface Props {
		areaID: string;
		filePath: string;
		fileName: string;
		position: Position;
		onBack: () => void;
		onUp?: () => void;
	}
	let { areaID, filePath, fileName, position, onBack, onUp }: Props = $props();
	let content = $state('');
	let originalContent = $state('');
	let loading = $state(true);
	let saving = $state(false);
	let error = $state<string | null>(null);
	// Text that failed to load is not entered from the toolbar: saving it would overwrite the file.
	let loadFailed = $state(false);
	let inputRef: ReturnType<typeof Input> | undefined = $state();
	let hasChanges = $derived(content !== originalContent);
	let toolbarActions = $derived([
		{ id: 'save', label: $t('common.save'), icon: '/img/check.svg', disabled: !hasChanges || saving },
		{ id: 'close', label: $t('common.back'), icon: '/img/back.svg', disabled: false },
	]);

	// One NavArea: the toolbar buttons on row 0 and the text below them on row 1.
	const TEXT_POS: NavPos = [0, 1];
	// The toolbar button the text returns to, so up and back land where the toolbar was left.
	let toolbarPos: NavPos = [0, 0];
	let fromText = false;
	const nav = createNavArea(() => ({
		areaID,
		position: { x: position.x + CONTENT_OFFSETS.main.x, y: position.y + CONTENT_OFFSETS.main.y },
		activate: true,
		initialPosition: [0, 0],
		onBack: handleBack,
		onSelect(pos: NavPos): void {
			if (pos[1] === TEXT_POS[1]) {
				fromText = true;
				return;
			}
			if (fromText) {
				fromText = false;
				leaveText();
				return;
			}
			toolbarPos = pos;
		},
		// Up is only left over on the toolbar row: the text moves up to the toolbar.
		onUp(): boolean {
			onUp?.();
			return true;
		},
		// Down stays put on both rows; without loaded text the toolbar has nothing below it.
		onDown: (): boolean => true,
		// The ends of the toolbar keep the selection; from the text the area layout decides.
		onLeft: (): boolean => !textSelected(),
		onRight: (): boolean => !textSelected(),
	}));

	function textSelected(): boolean {
		return nav.controller.isSelected(TEXT_POS);
	}

	function leaveText(): void {
		inputRef?.blur();
		nav.controller.select(toolbarPos);
	}

	function handleBack(): void {
		if (textSelected()) {
			fromText = false;
			leaveText();
		} else onBack();
	}

	async function loadFile(): Promise<void> {
		loading = true;
		error = null;
		try {
			content = await api.fs.readText(filePath);
			originalContent = content;
		} catch (e) {
			error = translateError(e);
			loadFailed = true;
		} finally {
			loading = false;
		}
	}

	async function handleSave(): Promise<void> {
		if (!hasChanges || saving) return;
		saving = true;
		error = null;
		try {
			const result = await api.fs.writeText(filePath, content);
			if (result.success) {
				originalContent = content;
				addNotification($t('fileBrowser.fileSaved', { name: fileName }), 'success');
			} else error = 'Failed to save file';
		} catch (e) {
			error = translateError(e);
		} finally {
			saving = false;
		}
	}

	function handleToolbarAction(actionID: string): void {
		switch (actionID) {
			case 'save':
				handleSave();
				break;
			case 'close':
				onBack();
				break;
		}
	}

	onMount(() => {
		loadFile();
	});
</script>

<style>
	.editor {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		gap: 1vh;
		margin: 2vh;
	}

	.toolbar {
		display: flex;
		gap: 1vh;
	}

	.content {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-height: 0;
	}

	.loading-container {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		height: 100%;
		gap: 2vh;
	}

	.editor-wrapper {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-height: 0;
		overflow: hidden;
	}

	.editor-wrapper :global(.input-field) {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-height: 0;
	}

	.editor-wrapper :global(textarea) {
		flex: 1;
		resize: none;
		font-family: var(--font-mono);
		overflow-y: auto;
	}
</style>

<div class="editor">
	<div class="toolbar">
		{#each toolbarActions as action, index (action.id)}
			<Button label={action.label} icon={action.icon} position={[index, 0]} disabled={action.disabled} onConfirm={() => handleToolbarAction(action.id)} />
		{/each}
	</div>
	{#if error}
		<Alert type="error" message={error} />
	{/if}
	<div class="content">
		{#if loading}
			<div class="loading-container">
				<Spinner size="8vh" />
			</div>
		{:else}
			<div class="editor-wrapper">
				<Input bind:this={inputRef} bind:value={content} multiline={true} rows={30} fontSize="1.8vh" padding="1vh" flex={true} position={loadFailed ? undefined : TEXT_POS} />
			</div>
		{/if}
	</div>
</div>
