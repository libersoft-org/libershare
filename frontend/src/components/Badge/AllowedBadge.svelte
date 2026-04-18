<script lang="ts">
	import { type EnabledMode } from '../../scripts/downloads.ts';
	import Icon from '../Icon/Icon.svelte';
	interface Props {
		mode?: EnabledMode | undefined;
		size?: string;
	}
	let { mode = 'disabled', size = '2.4vh' }: Props = $props();
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
		<Icon img="/img/arrow-down.svg" {size} padding="0" colorVariable="--mode-download-fg" />
		<Icon img="/img/arrow-up.svg" {size} padding="0" colorVariable="--mode-upload-fg" />
	{:else if mode === 'download'}
		<Icon img="/img/arrow-down.svg" {size} padding="0" colorVariable="--mode-download-fg" />
	{:else if mode === 'upload'}
		<Icon img="/img/arrow-up.svg" {size} padding="0" colorVariable="--mode-upload-fg" />
	{:else}
		<Icon img="/img/disabled.svg" {size} padding="0" colorVariable="--mode-disabled-fg" />
	{/if}
</span>
