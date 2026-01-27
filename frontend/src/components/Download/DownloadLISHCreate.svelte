<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { useArea, activeArea, activateArea } from '../../scripts/areas.ts';
	import type { Position } from '../../scripts/navigationLayout.ts';
	import { CONTENT_POSITIONS } from '../../scripts/navigationLayout.ts';
	import { scrollToElement } from '../../scripts/utils.ts';
	import { HASH_ALGORITHMS, parseChunkSize, type HashAlgorithm } from '../../scripts/lish.ts';
	import { storageLishPath } from '../../scripts/settings.ts';
	import Alert from '../Alert/Alert.svelte';
	import Button from '../Buttons/Button.svelte';
	import Input from '../Input/Input.svelte';
	interface Props {
		areaID: string;
		position?: Position;
		onBack?: () => void;
		onBrowseInput?: () => void;
		onBrowseOutput?: () => void;
	}
	let { areaID, position = CONTENT_POSITIONS.main, onBack, onBrowseInput, onBrowseOutput }: Props = $props();
	let active = $derived($activeArea === areaID);
	// Form state
	let inputPath = $state('');
	let outputPath = $state($storageLishPath + 'output.lish');
	let name = $state('');
	let description = $state('');
	let chunkSize = $state('1M'); // Default 1MB
	let algorithm = $state<HashAlgorithm>('sha256');
	let threads = $state('1');
	// Navigation state
	let selectedIndex = $state(0);
	let selectedColumn = $state(0); // For rows with multiple elements (input + browse, algo selector)
	let rowElements: HTMLElement[] = $state([]);
	let submitted = $state(false);
	// Input refs
	let inputPathInput: Input | undefined = $state();
	let outputPathInput: Input | undefined = $state();
	let nameInput: Input | undefined = $state();
	let descriptionInput: Input | undefined = $state();
	let chunkSizeInput: Input | undefined = $state();
	let threadsInput: Input | undefined = $state();
	// Validation
	let chunkSizeError = $derived.by(() => {
		if (!chunkSize.trim()) return null;
		const parsed = parseChunkSize(chunkSize);
		if (parsed === null) return $t.downloads?.lishCreate?.invalidChunkSize;
		return null;
	});
	let threadsError = $derived.by(() => {
		const num = parseInt(threads);
		if (threads.trim() && (isNaN(num) || num < 0)) {
			return $t.downloads?.lishCreate?.invalidThreads;
		}
		return null;
	});
	let errorMessage = $derived.by(() => {
		if (!inputPath.trim()) return $t.downloads?.lishCreate?.inputRequired;
		if (chunkSizeError) return chunkSizeError;
		if (threadsError) return threadsError;
		return '';
	});
	let showError = $derived(submitted && errorMessage);
	// Form fields: input(0), output(1), name(2), description(3), chunkSize(4), algo(5), threads(6), create(7), back(8)
	const FIELD_INPUT = 0;
	const FIELD_OUTPUT = 1;
	const FIELD_NAME = 2;
	const FIELD_DESCRIPTION = 3;
	const FIELD_CHUNK_SIZE = 4;
	const FIELD_ALGO = 5;
	const FIELD_THREADS = 6;
	const FIELD_CREATE = 7;
	const FIELD_BACK = 8;
	const TOTAL_FIELDS = 9;
	// Algorithm selection - horizontal navigation within the algo field
	let algoIndex = $derived(HASH_ALGORITHMS.indexOf(algorithm));

	function getMaxColumn(fieldIndex: number): number {
		if (fieldIndex === FIELD_INPUT) return 1; // input + browse
		if (fieldIndex === FIELD_OUTPUT) return 1; // output + browse
		if (fieldIndex === FIELD_ALGO) return HASH_ALGORITHMS.length - 1;
		return 0;
	}

	function focusInput(fieldIndex: number) {
		switch (fieldIndex) {
			case FIELD_INPUT:
				if (selectedColumn === 0) inputPathInput?.focus();
				break;
			case FIELD_OUTPUT:
				if (selectedColumn === 0) outputPathInput?.focus();
				break;
			case FIELD_NAME:
				nameInput?.focus();
				break;
			case FIELD_DESCRIPTION:
				descriptionInput?.focus();
				break;
			case FIELD_CHUNK_SIZE:
				chunkSizeInput?.focus();
				break;
			case FIELD_THREADS:
				threadsInput?.focus();
				break;
		}
	}

	function handleCreate() {
		submitted = true;
		if (!errorMessage) {
			// TODO: Call backend API to create LISH
			console.log('Creating LISH:', {
				inputPath,
				outputPath: outputPath || undefined,
				name: name || undefined,
				description: description || undefined,
				chunkSize: parseChunkSize(chunkSize),
				algorithm,
				threads: parseInt(threads) || 1,
			});
		}
	}

	const scrollToSelected = () => scrollToElement(rowElements, selectedIndex);

	onMount(() => {
		const unregister = useArea(
			areaID,
			{
				up: () => {
					if (selectedIndex === FIELD_BACK) {
						// Back is on same row as Create, go to previous row (threads)
						selectedIndex = FIELD_THREADS;
						selectedColumn = 0;
						scrollToSelected();
						return true;
					}
					if (selectedIndex > 0) {
						selectedIndex--;
						selectedColumn = selectedIndex === FIELD_ALGO ? algoIndex : 0;
						scrollToSelected();
						return true;
					}
					return false;
				},
				down: () => {
					// Don't go past FIELD_THREADS with down arrow
					// Create and Back are on the same row, reachable only via left/right
					if (selectedIndex >= FIELD_CREATE) {
						return false;
					}
					if (selectedIndex < FIELD_CREATE) {
						selectedIndex++;
						selectedColumn = selectedIndex === FIELD_ALGO ? algoIndex : 0;
						scrollToSelected();
						return true;
					}
					return false;
				},
				left: () => {
					if (selectedIndex === FIELD_BACK) {
						selectedIndex = FIELD_CREATE;
						return true;
					}
					if (selectedColumn > 0) {
						selectedColumn--;
						return true;
					}
					return false;
				},
				right: () => {
					if (selectedIndex === FIELD_CREATE) {
						selectedIndex = FIELD_BACK;
						return true;
					}
					const maxCol = getMaxColumn(selectedIndex);
					if (selectedColumn < maxCol) {
						selectedColumn++;
						return true;
					}
					return false;
				},
				confirmDown: () => {},
				confirmUp: () => {
					if (selectedIndex === FIELD_INPUT) {
						if (selectedColumn === 0) focusInput(FIELD_INPUT);
						else onBrowseInput?.();
					} else if (selectedIndex === FIELD_OUTPUT) {
						if (selectedColumn === 0) focusInput(FIELD_OUTPUT);
						else onBrowseOutput?.();
					} else if (selectedIndex === FIELD_NAME) {
						focusInput(FIELD_NAME);
					} else if (selectedIndex === FIELD_DESCRIPTION) {
						focusInput(FIELD_DESCRIPTION);
					} else if (selectedIndex === FIELD_CHUNK_SIZE) {
						focusInput(FIELD_CHUNK_SIZE);
					} else if (selectedIndex === FIELD_ALGO) {
						algorithm = HASH_ALGORITHMS[selectedColumn];
					} else if (selectedIndex === FIELD_THREADS) {
						focusInput(FIELD_THREADS);
					} else if (selectedIndex === FIELD_CREATE) {
						handleCreate();
					} else if (selectedIndex === FIELD_BACK) {
						onBack?.();
					}
				},
				confirmCancel: () => {},
				back: () => onBack?.(),
				onActivate: () => {
					// When algo row is active, sync selectedColumn with current algorithm
					if (selectedIndex === FIELD_ALGO) selectedColumn = algoIndex;
				},
			},
			position
		);
		activateArea(areaID);
		return unregister;
	});
</script>

<style>
	.create {
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

	.row {
		display: flex;
		gap: 1vh;
		align-items: flex-end;
	}

	.label {
		font-size: 2vh;
		color: var(--disabled-foreground);
		margin-top: 1vh;
	}

	.algo-selector {
		display: flex;
		flex-wrap: wrap;
		gap: 1vh;
	}
</style>

<div class="create">
	<div class="container">
		<!-- Input Path (required) -->
		<div class="row" bind:this={rowElements[FIELD_INPUT]}>
			<Input bind:this={inputPathInput} bind:value={inputPath} label={$t.downloads?.lishCreate?.inputPath} placeholder="/path/to/file/or/directory" selected={active && selectedIndex === FIELD_INPUT && selectedColumn === 0} flex />
			<Button icon="/img/folder.svg" selected={active && selectedIndex === FIELD_INPUT && selectedColumn === 1} onConfirm={onBrowseInput} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
		</div>
		<!-- Output Path (optional) -->
		<div class="row" bind:this={rowElements[FIELD_OUTPUT]}>
			<Input bind:this={outputPathInput} bind:value={outputPath} label={$t.downloads?.lishCreate?.outputPath} placeholder="/path/to/output.lish" selected={active && selectedIndex === FIELD_OUTPUT && selectedColumn === 0} flex />
			<Button icon="/img/folder.svg" selected={active && selectedIndex === FIELD_OUTPUT && selectedColumn === 1} onConfirm={onBrowseOutput} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
		</div>
		<!-- Name (optional) -->
		<div bind:this={rowElements[FIELD_NAME]}>
			<Input bind:this={nameInput} bind:value={name} label={$t.downloads?.lishCreate?.name} selected={active && selectedIndex === FIELD_NAME} />
		</div>
		<!-- Description (optional) -->
		<div bind:this={rowElements[FIELD_DESCRIPTION]}>
			<Input bind:this={descriptionInput} bind:value={description} label={$t.downloads?.lishCreate?.description} multiline rows={3} selected={active && selectedIndex === FIELD_DESCRIPTION} />
		</div>
		<!-- Chunk Size -->
		<div bind:this={rowElements[FIELD_CHUNK_SIZE]}>
			<Input bind:this={chunkSizeInput} bind:value={chunkSize} label={$t.downloads?.lishCreate?.chunkSize} placeholder="1M" selected={active && selectedIndex === FIELD_CHUNK_SIZE} />
		</div>
		<!-- Hash Algorithm -->
		<div bind:this={rowElements[FIELD_ALGO]}>
			<div class="label">{$t.downloads?.lishCreate?.algorithm}:</div>
			<div class="algo-selector">
				{#each HASH_ALGORITHMS as algo, i}
					<Button label={algo} selected={active && selectedIndex === FIELD_ALGO && selectedColumn === i} active={algorithm === algo} onConfirm={() => (algorithm = algo)} padding="1vh 2vh" fontSize="2vh" borderRadius="1vh" />
				{/each}
			</div>
		</div>
		<!-- Threads -->
		<div bind:this={rowElements[FIELD_THREADS]}>
			<Input bind:this={threadsInput} bind:value={threads} label={$t.downloads?.lishCreate?.threads} placeholder="1" type="number" min={0} selected={active && selectedIndex === FIELD_THREADS} />
		</div>
		<Alert type="error" message={showError ? errorMessage : ''} />
	</div>
	<div class="buttons">
		<div bind:this={rowElements[FIELD_CREATE]}>
			<Button icon="/img/plus.svg" label={$t.downloads?.lishCreate?.create} selected={active && selectedIndex === FIELD_CREATE} onConfirm={handleCreate} />
		</div>
		<div bind:this={rowElements[FIELD_BACK]}>
			<Button icon="/img/back.svg" label={$t.common?.back} selected={active && selectedIndex === FIELD_BACK} onConfirm={onBack} />
		</div>
	</div>
</div>
