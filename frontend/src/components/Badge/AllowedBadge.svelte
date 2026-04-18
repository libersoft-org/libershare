<script lang="ts">
	import { type EnabledMode } from '../../scripts/downloads.ts';
	import Icon from '../Icon/Icon.svelte';
	interface Props {
		mode?: EnabledMode | undefined;
		size?: string;
		downloadColorVariable?: string;
		uploadColorVariable?: string;
		disabledColorVariable?: string;
	}
	let { mode = 'disabled', size = '2.4vh', downloadColorVariable = '--mode-download-fg', uploadColorVariable = '--mode-upload-fg', disabledColorVariable = '--mode-disabled-fg' }: Props = $props();
</script>

<style>
	.mode-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.1vh;
	}
</style>

<span class="mode-icon">
	{#if mode === 'both'}
		<Icon img="/img/arrow-down.svg" {size} padding="0" colorVariable={downloadColorVariable} />
		<Icon img="/img/arrow-up.svg" {size} padding="0" colorVariable={uploadColorVariable} />
	{:else if mode === 'download'}
		<Icon img="/img/arrow-down.svg" {size} padding="0" colorVariable={downloadColorVariable} />
	{:else if mode === 'upload'}
		<Icon img="/img/arrow-up.svg" {size} padding="0" colorVariable={uploadColorVariable} />
	{:else}
		<Icon img="/img/disabled.svg" {size} padding="0" colorVariable={disabledColorVariable} />
	{/if}
</span>
