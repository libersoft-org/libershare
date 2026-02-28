<script lang="ts">
	import { onMount } from 'svelte';
	import { useArea, activateArea, activeArea } from '../../scripts/areas.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { CONTENT_OFFSETS } from '../../scripts/navigationLayout.ts';
	import { api } from '../../scripts/api.ts';
	import { t } from '../../scripts/language.ts';
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
	let { areaID, filePath, position, onBack, onUp }: Props = $props();
	// Calculate sub-area positions
	let toolbarPosition = $derived({ x: position.x + CONTENT_OFFSETS.top.x, y: position.y + CONTENT_OFFSETS.top.y });
	let editorPosition = $derived({ x: position.x + CONTENT_OFFSETS.main.x, y: position.y + CONTENT_OFFSETS.main.y });
	let toolbarAreaID = $derived(`${areaID}-toolbar`);
	let editorAreaID = $derived(`${areaID}-editor`);
	let content = $state('');
	let originalContent = $state('');
	let loading = $state(true);
	let saving = $state(false);
	let error = $state<string | null>(null);
	let inputRef: ReturnType<typeof Input> | undefined = $state();
	let selectedToolbarIndex = $state(0);
	let toolbarActive = $derived($activeArea === toolbarAreaID);
	let editorActive = $derived($activeArea === editorAreaID);
	let hasChanges = $derived(content !== originalContent);
	let toolbarActions = $derived([
		{ id: 'save', label: $t('common.save'), icon: '/img/check.svg', disabled: !hasChanges || saving },
		{ id: 'close', label: $t('common.back'), icon: '/img/back.svg', disabled: false },
	]);
	let unregisterToolbar: (() => void) | null = null;
	let unregisterEditor: (() => void) | null = null;

	async function loadFile(): Promise<void> {
		loading = true;
		error = null;
		try {
			content = await api.fs.readText(filePath);
			originalContent = content;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load file';
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
			if (result.success) originalContent = content;
			else error = 'Failed to save file';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to save file';
		} finally {
			saving = false;
		}
	}

	function handleToolbarAction(actionId: string): void {
		switch (actionId) {
			case 'save':
				handleSave();
				break;
			case 'close':
				onBack();
				break;
		}
	}

	const toolbarAreaHandlers = {
		up() {
			onUp?.();
			return true;
		},
		down() {
			if (!loading && !error) activateArea(editorAreaID);
			return true;
		},
		left() {
			if (selectedToolbarIndex > 0) selectedToolbarIndex--;
			return true;
		},
		right() {
			if (selectedToolbarIndex < toolbarActions.length - 1) selectedToolbarIndex++;
			return true;
		},
		confirmUp() {
			const action = toolbarActions[selectedToolbarIndex]!;
			if (!action.disabled) handleToolbarAction(action.id);
		},
		back() {
			onBack();
		},
	};

	const editorAreaHandlers = {
		up() {
			inputRef?.blur();
			activateArea(toolbarAreaID);
			return true;
		},
		down() {
			return true;
		},
		left() {
			return false;
		},
		right() {
			return false;
		},
		confirmUp() {
			inputRef?.focus();
		},
		back() {
			inputRef?.blur();
			activateArea(toolbarAreaID);
		},
	};

	onMount(() => {
		loadFile();
		unregisterToolbar = useArea(toolbarAreaID, toolbarAreaHandlers, toolbarPosition);
		unregisterEditor = useArea(editorAreaID, editorAreaHandlers, editorPosition);
		activateArea(toolbarAreaID);
		return () => {
			unregisterToolbar?.();
			unregisterEditor?.();
		};
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
		font-family: 'Ubuntu Mono';
		overflow-y: auto;
	}
</style>

<div class="editor">
	<div class="toolbar">
		{#each toolbarActions as action, index (action.id)}
			<Button label={action.label} icon={action.icon} selected={toolbarActive && selectedToolbarIndex === index} disabled={action.disabled} onConfirm={() => handleToolbarAction(action.id)} />
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
				<Input bind:this={inputRef} bind:value={content} multiline={true} rows={30} fontSize="1.8vh" padding="1vh" flex={true} selected={editorActive} />
			</div>
		{/if}
	</div>
</div>
