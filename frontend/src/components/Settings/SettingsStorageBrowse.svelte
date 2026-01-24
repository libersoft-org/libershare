<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { useArea, activateArea, activeArea } from '../../scripts/areas.ts';
	import FileBrowser from '../FileBrowser/FileBrowser.svelte';
	import Button from '../Buttons/Button.svelte';

	interface Props {
		areaID: string;
		initialPath?: string;
		onSelect?: (path: string) => void;
		onBack?: () => void;
	}

	let { areaID, initialPath = '', onSelect, onBack }: Props = $props();
	let active = $derived($activeArea === areaID);
	let browserRef: FileBrowser | undefined = $state();
	let isButtonSelected = $state(false);

	function selectCurrentPath() {
		const path = browserRef?.getCurrentPath() ?? '';
		onSelect?.(path);
	}

	function handleBrowserBack() {
		// FileBrowser handles its own back navigation
		// This is only called when at root
		onBack?.();
	}

	// We need to handle switching between browser and button
	// FileBrowser manages its own area, so we use a wrapper area
	const wrapperAreaID = `${areaID}-wrapper`;

	onMount(() => {
		const unregister = useArea(wrapperAreaID, {
			up: () => {
				if (isButtonSelected) {
					isButtonSelected = false;
					activateArea(areaID);
					return true;
				}
				return false;
			},
			down: () => {
				// This area only handles the button
				return false;
			},
			left: () => false,
			right: () => false,
			confirmDown: () => {},
			confirmUp: () => {
				if (isButtonSelected) {
					selectCurrentPath();
				}
			},
			confirmCancel: () => {},
			back: () => {
				if (isButtonSelected) {
					isButtonSelected = false;
					activateArea(areaID);
				} else {
					onBack?.();
				}
			},
		});

		return unregister;
	});

	// Intercept down navigation from FileBrowser to move to button
	function handleFileBrowserDown(): boolean {
		// Called when FileBrowser can't go down anymore
		isButtonSelected = true;
		activateArea(wrapperAreaID);
		return true;
	}
</script>

<style>
	.browse {
		display: flex;
		flex-direction: column;
		height: 100%;
		gap: 2vh;
	}

	.browser-container {
		flex: 1;
		overflow: hidden;
		border: 0.2vh solid var(--secondary-softer-background);
		border-radius: 1vh;
	}

	.actions {
		display: flex;
		justify-content: center;
		padding: 2vh;
		gap: 2vh;
	}
</style>

<div class="browse">
	<div class="browser-container">
		<FileBrowser bind:this={browserRef} {areaID} {initialPath} foldersOnly showPath onBack={handleBrowserBack} onDownAtEnd={handleFileBrowserDown} />
	</div>
	<div class="actions">
		<Button label={$t.settings?.storage?.selectFolder ?? 'Vybrat adresář'} selected={active && isButtonSelected} onConfirm={selectCurrentPath} />
	</div>
</div>
