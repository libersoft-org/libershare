<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { useArea, activeArea, activateArea } from '../../scripts/areas.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { CONTENT_POSITIONS } from '../../scripts/navigationLayout.ts';
	import { pushBreadcrumb, popBreadcrumb } from '../../scripts/navigation.ts';
	import { pushBackHandler } from '../../scripts/focus.ts';
	import { scrollToElement, sanitizeFilename } from '../../scripts/utils.ts';
	import { HASH_ALGORITHMS, parseChunkSize, validateLishCreateForm, getLishCreateErrorMessage, type HashAlgorithm } from '../../scripts/lish.ts';
	import { storageLishPath, storagePath, autoStartSharing } from '../../scripts/settings.ts';
	import { splitPath, joinPath } from '../../scripts/fileBrowser.ts';
	import Alert from '../../components/Alert/Alert.svelte';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Input from '../../components/Input/Input.svelte';
	import SwitchRow from '../../components/Switch/SwitchRow.svelte';
	import FileBrowser from '../FileBrowser/FileBrowser.svelte';
	interface Props {
		areaID: string;
		position?: Position;
		onBack?: () => void;
	}
	let { areaID, position = CONTENT_POSITIONS.main, onBack }: Props = $props();
	let unregisterArea: (() => void) | null = null;
	let removeBackHandler: (() => void) | null = null;
	let active = $derived($activeArea === areaID);
	// Browse state
	let browsingInputPath = $state(false);
	let browsingLishFile = $state(false);
	let browseFolder = $state('');
	let browseFile = $state<string | undefined>(undefined);
	let lishFileName = $state(''); // File name input in lishFile browse dialog
	// Form state
	let dataPath = $state($storagePath);
	let saveToFile = $state(true);
	let addToSharing = $state($autoStartSharing);
	let showAdvanced = $state(false);
	let name = $state('');
	// LISH file path - editable state, initialized from settings
	let lishFile = $state(joinPath($storageLishPath, 'output.lish'));
	let lishFileManuallyEdited = $state(false); // Track if user manually edited the path

	function handleNameChange(newName: string) {
		name = newName;
		if (!lishFileManuallyEdited && newName) {
			const sanitized = sanitizeFilename(newName);
			if (sanitized) {
				const { folder } = splitPath(lishFile || $storageLishPath, $storageLishPath);
				lishFile = joinPath(folder, sanitized + '.lish');
			}
		}
	}

	let description = $state('');
	let chunkSize = $state('1M'); // Default 1MB
	let algorithm = $state<HashAlgorithm>('sha256');
	let threads = $state('0');
	// Navigation state
	let selectedIndex = $state(0);
	let selectedColumn = $state(0); // For rows with multiple elements (input + browse, algo selector)
	let rowElements: HTMLElement[] = $state([]);
	let submitted = $state(false);
	// Input refs
	let inputPathInput: Input | undefined = $state();
	let lishFileInput: Input | undefined = $state();
	let nameInput: Input | undefined = $state();
	let descriptionInput: Input | undefined = $state();
	let chunkSizeInput: Input | undefined = $state();
	let threadsInput: Input | undefined = $state();
	// Validation using lish.ts
	let validationError = $derived(validateLishCreateForm({ dataPath, lishFile: saveToFile ? lishFile || undefined : undefined, addToSharing, chunkSize, threads }));
	let errorMessage = $derived(validationError ? getLishCreateErrorMessage(validationError, $t) : '');
	let showError = $derived(submitted && errorMessage);
	// Form fields: name(0), description(1), dataPath(2), saveToFile(3), lishFile(4), addToSharing(5), advancedToggle(6), chunkSize(7), algo(8), threads(9), create(10), back(11)
	const FIELD_NAME = 0;
	const FIELD_DESCRIPTION = 1;
	const FIELD_INPUT = 2;
	const FIELD_SAVE_TO_FILE = 3;
	const FIELD_LISH_FILE = 4;
	const FIELD_ADD_TO_SHARING = 5;
	const FIELD_ADVANCED_TOGGLE = 6;
	const FIELD_CHUNK_SIZE = 7;
	const FIELD_ALGO = 8;
	const FIELD_THREADS = 9;
	const FIELD_CREATE = 10;
	const FIELD_BACK = 11;
	const TOTAL_FIELDS = 12;
	// Algorithm selection - horizontal navigation within the algo field
	let algoIndex = $derived(HASH_ALGORITHMS.indexOf(algorithm));

	function getMaxColumn(fieldIndex: number): number {
		if (fieldIndex === FIELD_INPUT) return 1; // input + browse
		if (fieldIndex === FIELD_LISH_FILE) return 1; // lishFile + browse
		if (fieldIndex === FIELD_ALGO) return HASH_ALGORITHMS.length - 1;
		return 0;
	}

	function focusInput(fieldIndex: number) {
		switch (fieldIndex) {
			case FIELD_INPUT:
				if (selectedColumn === 0) inputPathInput?.focus();
				break;
			case FIELD_LISH_FILE:
				if (selectedColumn === 0) lishFileInput?.focus();
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
				name: name || undefined,
				description: description || undefined,
				dataPath,
				lishFile: saveToFile ? lishFile || undefined : undefined,
				addToSharing,
				chunkSize: parseChunkSize(chunkSize),
				algorithm,
				threads: parseInt(threads) || 0,
			});
		}
	}

	function openInputPathBrowse() {
		const { folder, fileName } = splitPath(dataPath.trim(), $storagePath);
		browseFolder = folder;
		browseFile = fileName;
		browsingInputPath = true;
		if (unregisterArea) {
			unregisterArea();
			unregisterArea = null;
		}
		pushBreadcrumb($t('downloads.lishCreate.dataPath'));
		removeBackHandler = pushBackHandler(handleBrowseBack);
	}

	function handleInputPathSelect(path: string) {
		dataPath = path;
		handleBrowseBack();
	}

	function openOutputPathBrowse() {
		const { folder, fileName } = splitPath(lishFile.trim() || $storageLishPath, $storageLishPath);
		browseFolder = folder;
		lishFileName = fileName || '';
		browsingLishFile = true;
		if (unregisterArea) {
			unregisterArea();
			unregisterArea = null;
		}
		pushBreadcrumb($t('downloads.lishCreate.lishFile'));
		removeBackHandler = pushBackHandler(handleOutputBrowseBack);
	}

	function handleOutputPathSelect(folderPath: string) {
		const fileName = lishFileName.trim() || 'output.lish';
		lishFile = joinPath(folderPath, fileName);
		lishFileManuallyEdited = true;
		handleOutputBrowseBack();
	}

	async function handleOutputBrowseBack() {
		if (removeBackHandler) {
			removeBackHandler();
			removeBackHandler = null;
		}
		popBreadcrumb();
		browsingLishFile = false;
		await tick();
		unregisterArea = registerAreaHandler();
		// Restore focus to the browse button
		selectedIndex = FIELD_LISH_FILE;
		selectedColumn = 1;
		activateArea(areaID);
		await tick();
		scrollToSelected();
	}

	async function handleBrowseBack() {
		if (removeBackHandler) {
			removeBackHandler();
			removeBackHandler = null;
		}
		popBreadcrumb();
		browsingInputPath = false;
		await tick();
		unregisterArea = registerAreaHandler();
		// Restore focus to the browse button
		selectedIndex = FIELD_INPUT;
		selectedColumn = 1;
		activateArea(areaID);
		await tick();
		scrollToSelected();
	}

	function registerAreaHandler() {
		return useArea(areaID, areaHandlers, position);
	}

	function scrollToSelected() {
		scrollToElement(rowElements, selectedIndex);
	}

	const areaHandlers = {
		up: () => {
			if (selectedIndex === FIELD_BACK) {
				// Back is on same row as Create, go to last visible row before buttons
				selectedIndex = showAdvanced ? FIELD_THREADS : FIELD_ADVANCED_TOGGLE;
				selectedColumn = 0;
				scrollToSelected();
				return true;
			}
			if (selectedIndex > 0) {
				selectedIndex--;
				// Skip disabled lish file field when saveToFile is off
				if (!saveToFile && selectedIndex === FIELD_LISH_FILE) selectedIndex--;
				// Skip advanced fields when collapsed
				if (!showAdvanced && selectedIndex >= FIELD_CHUNK_SIZE && selectedIndex <= FIELD_THREADS) {
					selectedIndex = FIELD_ADVANCED_TOGGLE;
				}
				selectedColumn = selectedIndex === FIELD_ALGO ? algoIndex : 0;
				scrollToSelected();
				return true;
			}
			return false;
		},
		down: () => {
			if (selectedIndex >= FIELD_CREATE) {
				return false;
			}
			if (selectedIndex < FIELD_CREATE) {
				selectedIndex++;
				// Skip disabled lish file field when saveToFile is off
				if (!saveToFile && selectedIndex === FIELD_LISH_FILE) selectedIndex++;
				// Skip advanced fields when collapsed
				if (!showAdvanced && selectedIndex >= FIELD_CHUNK_SIZE && selectedIndex <= FIELD_THREADS) selectedIndex = FIELD_CREATE;
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
			if (selectedIndex === FIELD_NAME) {
				focusInput(FIELD_NAME);
			} else if (selectedIndex === FIELD_DESCRIPTION) {
				focusInput(FIELD_DESCRIPTION);
			} else if (selectedIndex === FIELD_INPUT) {
				if (selectedColumn === 0) focusInput(FIELD_INPUT);
				else openInputPathBrowse();
			} else if (selectedIndex === FIELD_SAVE_TO_FILE) {
				saveToFile = !saveToFile;
			} else if (selectedIndex === FIELD_LISH_FILE) {
				if (selectedColumn === 0) focusInput(FIELD_LISH_FILE);
				else openOutputPathBrowse();
			} else if (selectedIndex === FIELD_ADD_TO_SHARING) {
				addToSharing = !addToSharing;
			} else if (selectedIndex === FIELD_ADVANCED_TOGGLE) {
				showAdvanced = !showAdvanced;
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
	};

	onMount(() => {
		unregisterArea = registerAreaHandler();
		activateArea(areaID);
		return () => {
			if (unregisterArea) unregisterArea();
		};
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

{#if browsingInputPath}
	<FileBrowser {areaID} {position} initialPath={browseFolder} initialFile={browseFile} showPath selectFolderButton selectFileButton onSelect={handleInputPathSelect} onBack={handleBrowseBack} />
{:else if browsingLishFile}
	<FileBrowser {areaID} {position} initialPath={browseFolder} showPath foldersOnly selectFolderButton saveFileName={lishFileName} onSaveFileNameChange={v => (lishFileName = v)} onSelect={handleOutputPathSelect} onBack={handleOutputBrowseBack} />
{:else}
	<div class="create">
		<div class="container">
			<!-- Name (optional) -->
			<div bind:this={rowElements[FIELD_NAME]}>
				<Input bind:this={nameInput} value={name} onchange={handleNameChange} label={$t('downloads.lishCreate.name')} selected={active && selectedIndex === FIELD_NAME} />
			</div>
			<!-- Description (optional) -->
			<div bind:this={rowElements[FIELD_DESCRIPTION]}>
				<Input bind:this={descriptionInput} bind:value={description} label={$t('downloads.lishCreate.description')} multiline rows={3} selected={active && selectedIndex === FIELD_DESCRIPTION} />
			</div>
			<!-- Data Path (required) -->
			<div class="row" bind:this={rowElements[FIELD_INPUT]}>
				<Input bind:this={inputPathInput} bind:value={dataPath} label={$t('downloads.lishCreate.dataPath')} selected={active && selectedIndex === FIELD_INPUT && selectedColumn === 0} flex />
				<Button icon="/img/folder.svg" selected={active && selectedIndex === FIELD_INPUT && selectedColumn === 1} onConfirm={openInputPathBrowse} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" />
			</div>
			<!-- Save to File Switch -->
			<div bind:this={rowElements[FIELD_SAVE_TO_FILE]}>
				<SwitchRow label={$t('downloads.lishCreate.saveToFile') + ':'} checked={saveToFile} selected={active && selectedIndex === FIELD_SAVE_TO_FILE} onConfirm={() => (saveToFile = !saveToFile)} />
			</div>
			<!-- LISH File Path (optional, enabled when saveToFile is on) -->
			<div class="row" bind:this={rowElements[FIELD_LISH_FILE]}>
				<Input bind:this={lishFileInput} bind:value={lishFile} label={$t('downloads.lishCreate.lishFile')} selected={active && selectedIndex === FIELD_LISH_FILE && selectedColumn === 0} flex disabled={!saveToFile} onchange={() => (lishFileManuallyEdited = true)} />
				<Button icon="/img/folder.svg" selected={active && selectedIndex === FIELD_LISH_FILE && selectedColumn === 1} onConfirm={openOutputPathBrowse} padding="1vh" fontSize="4vh" borderRadius="1vh" width="6.6vh" height="6.6vh" disabled={!saveToFile} />
			</div>
			<!-- Add to Sharing Switch -->
			<div bind:this={rowElements[FIELD_ADD_TO_SHARING]}>
				<SwitchRow label={$t('downloads.lishImport.autoStartSharing') + ':'} checked={addToSharing} selected={active && selectedIndex === FIELD_ADD_TO_SHARING} onConfirm={() => (addToSharing = !addToSharing)} />
			</div>
			<!-- Advanced Settings Toggle -->
			<div bind:this={rowElements[FIELD_ADVANCED_TOGGLE]}>
				<Button label={(showAdvanced ? '▾ ' : '▸ ') + $t(showAdvanced ? 'downloads.lishCreate.hideAdvanced' : 'downloads.lishCreate.showAdvanced')} selected={active && selectedIndex === FIELD_ADVANCED_TOGGLE} onConfirm={() => (showAdvanced = !showAdvanced)} padding="1vh 2vh" fontSize="2vh" borderRadius="1vh" />
			</div>
			{#if showAdvanced}
				<!-- Chunk Size -->
				<div bind:this={rowElements[FIELD_CHUNK_SIZE]}>
					<Input bind:this={chunkSizeInput} bind:value={chunkSize} label={$t('downloads.lishCreate.chunkSize')} selected={active && selectedIndex === FIELD_CHUNK_SIZE} />
				</div>
				<!-- Hash Algorithm -->
				<div bind:this={rowElements[FIELD_ALGO]}>
					<div class="label">{$t('downloads.lishCreate.algorithm')}:</div>
					<div class="algo-selector">
						{#each HASH_ALGORITHMS as algo, i}
							<Button label={algo} selected={active && selectedIndex === FIELD_ALGO && selectedColumn === i} active={algorithm === algo} onConfirm={() => (algorithm = algo)} padding="1vh 2vh" fontSize="2vh" borderRadius="1vh" />
						{/each}
					</div>
				</div>
				<!-- Threads -->
				<div bind:this={rowElements[FIELD_THREADS]}>
					<Input bind:this={threadsInput} bind:value={threads} label={$t('downloads.lishCreate.threads')} type="number" min={0} selected={active && selectedIndex === FIELD_THREADS} />
				</div>
			{/if}
			<Alert type="error" message={showError ? errorMessage : ''} />
		</div>
		<ButtonBar justify="center">
			<div bind:this={rowElements[FIELD_CREATE]}>
				<Button icon="/img/plus.svg" label={$t('downloads.lishCreate.create')} selected={active && selectedIndex === FIELD_CREATE} onConfirm={handleCreate} />
			</div>
			<div bind:this={rowElements[FIELD_BACK]}>
				<Button icon="/img/back.svg" label={$t('common.back')} selected={active && selectedIndex === FIELD_BACK} onConfirm={onBack} />
			</div>
		</ButtonBar>
	</div>
{/if}
