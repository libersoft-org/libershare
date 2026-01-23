<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { useArea, activeArea, activateArea } from '../../scripts/areas.ts';
	import { addNetworkIfNotExists, type LISHNetwork } from '../../scripts/lishnet.ts';
	import Alert from '../Alert/Alert.svelte';
	import Button from '../Buttons/Button.svelte';
	import Input from '../Input/Input.svelte';
	interface Props {
		areaID: string;
		onBack?: () => void;
		onImport?: () => void;
	}
	let { areaID, onBack, onImport }: Props = $props();
	let active = $derived($activeArea === areaID);
	let selectedIndex = $state(0); // 0 = input, 1 = buttons row
	let selectedColumn = $state(0); // 0 = load from file, 1 = import, 2 = back
	let inputRef: Input;
	let networkJson = $state('');
	let errorMessage = $state('');

	function validateNetwork(obj: unknown): LISHNetwork | null {
		if (!obj || typeof obj !== 'object') return null;
		const parsed = obj as Record<string, unknown>;
		// Validate required fields:
		// - networkID: required, non-empty string
		// - name: required, non-empty string
		// - bootstrapPeers: optional, can be empty
		if (typeof parsed.networkID !== 'string' || !parsed.networkID.trim() || typeof parsed.name !== 'string' || !parsed.name.trim()) return null;
		const bootstrapPeers = Array.isArray(parsed.bootstrapPeers) ? (parsed.bootstrapPeers as string[]).filter(p => typeof p === 'string' && p.trim()) : [];
		return {
			version: (parsed.version as number) ?? 1,
			networkID: parsed.networkID.trim(),
			name: parsed.name.trim(),
			description: typeof parsed.description === 'string' ? parsed.description : '',
			bootstrapPeers,
			created: (parsed.created as string) ?? new Date().toISOString(),
		};
	}

	function handleImport() {
		errorMessage = '';
		if (!networkJson.trim()) {
			errorMessage = $t.settings?.lishNetwork?.errorInvalidFormat ?? 'Invalid format';
			return;
		}
		try {
			const parsed = JSON.parse(networkJson);
			const networksToImport: LISHNetwork[] = [];
			// Check if it's an array of networks or a single network
			if (Array.isArray(parsed)) {
				for (const item of parsed) {
					const network = validateNetwork(item);
					if (network) networksToImport.push(network);
				}
			} else {
				const network = validateNetwork(parsed);
				if (network) networksToImport.push(network);
			}

			if (networksToImport.length === 0) {
				errorMessage = $t.settings?.lishNetwork?.errorNoValidNetworks ?? 'No valid networks found';
				return;
			}

			// Add all valid networks
			for (const network of networksToImport) {
				addNetworkIfNotExists(network);
			}
			onImport?.();
		} catch {
			errorMessage = $t.settings?.lishNetwork?.errorInvalidFormat ?? 'Invalid format';
		}
	}

	onMount(() => {
		const unregister = useArea(areaID, {
			up: () => {
				if (selectedIndex > 0) {
					selectedIndex--;
					return true;
				}
				return false;
			},
			down: () => {
				if (selectedIndex < 1) {
					selectedIndex++;
					selectedColumn = 0;
					return true;
				}
				return false;
			},
			left: () => {
				if (selectedIndex === 1 && selectedColumn > 0) {
					selectedColumn--;
					return true;
				}
				return false;
			},
			right: () => {
				if (selectedIndex === 1 && selectedColumn < 2) {
					selectedColumn++;
					return true;
				}
				return false;
			},
			confirmDown: () => {
				if (selectedIndex === 0) inputRef?.focus();
			},
			confirmUp: () => {
				if (selectedIndex === 1) {
					if (selectedColumn === 0) {
						// Load from file - TODO: connect to backend
					} else if (selectedColumn === 1) {
						handleImport();
					} else if (selectedColumn === 2) {
						onBack?.();
					}
				}
			},
			confirmCancel: () => {},
			back: () => onBack?.(),
		});
		activateArea(areaID);
		return unregister;
	});
</script>

<style>
	.import {
		display: flex;
		flex-direction: column;
		align-items: center;
		height: 100%;
		padding: 2vh;
		gap: 2vh;
	}

	.container {
		display: flex;
		flex-direction: column;
		gap: 1vh;
		width: 800px;
		max-width: 100%;
	}

	.buttons {
		display: flex;
		justify-content: center;
		gap: 2vh;
	}
</style>

<div class="import">
	<div class="container">
		<Input bind:this={inputRef} bind:value={networkJson} multiline rows={15} fontSize="2vh" selected={active && selectedIndex === 0} placeholder={'{"networkID": "...", "name": "...", ...}'} />
		<Alert type="error" message={errorMessage} />
	</div>
	<div class="buttons">
		<Button label="{$t.common?.load} ..." selected={active && selectedIndex === 1 && selectedColumn === 0} />
		<Button label={$t.common?.import} selected={active && selectedIndex === 1 && selectedColumn === 1} onConfirm={handleImport} />
		<Button label={$t.common?.back} selected={active && selectedIndex === 1 && selectedColumn === 2} onConfirm={onBack} />
	</div>
</div>
