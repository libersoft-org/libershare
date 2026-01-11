<script lang="ts">
	import { onMount } from 'svelte';
	import Header from '../components/Header/Header.svelte';
	import Breadcrumb from '../components/Breadcrumb/Breadcrumb.svelte';
	import Menu from '../components/Menu/Menu.svelte';
	import Footer from '../components/Footer/Footer.svelte';
	import ConfirmDialog from '../components/Dialog/ConfirmDialog.svelte';
	import { createNavigation, breadcrumbItems, setContentElement, confirmDialog, hideConfirmDialog } from '../scripts/navigation.ts';
	import { confirmDialogs } from '../scripts/menu.ts';
	import { productName } from '../scripts/app.ts';
	import { startInput } from '../scripts/input.ts';
	import { getAPILocal } from '../scripts/api.ts';
	import { setAreaPosition, activateArea } from '../scripts/areas.ts';
	import { initAudio, play } from '../scripts/audio.ts';
	import { cursorVisible } from '../scripts/mouse.ts';
	import { cursorSize, cursorSizes, footerVisible } from '../scripts/settings.ts';
	const { currentItems, currentComponent, currentTitle, currentOrientation, selectedId, navigate, onBack: onBack } = createNavigation();
	let contentElement: HTMLElement;
	let cursorX = $state(0);
	let cursorY = $state(0);
	let cursorMoved = $state(false);
	let cursorSizeValue = $derived(cursorSizes[$cursorSize]);

	function handleMouseMove(e: MouseEvent) {
		cursorX = e.clientX;
		cursorY = e.clientY;
		cursorMoved = true;
	}

	function handleConfirm() {
		if ($confirmDialog.action && $confirmDialog.action !== 'back') {
			play('exit');
			const dialogConfig = $confirmDialogs[$confirmDialog.action as 'restart' | 'shutdown' | 'quit'];
			if (dialogConfig) getAPILocal(dialogConfig.apiAction);
		}
		hideConfirmDialog();
	}

	function handleCancel() {
		hideConfirmDialog();
	}

	onMount(() => {
		// Setup area layout
		setAreaPosition('header', { x: 0, y: 0 });
		setAreaPosition('breadcrumb', { x: 0, y: 1 });
		setAreaPosition('content', { x: 0, y: 2 });
		setContentElement(contentElement);
		startInput();
		activateArea('content');
		initAudio();
		play('welcome');
	});
</script>

<style>
	.page {
		display: flex;
		flex-direction: column;
		height: 100dvh;
		overflow: hidden;
	}

	.content {
		flex: 1;
		overflow-y: auto;
	}
</style>

<svelte:head>
	<title>{productName}</title>
</svelte:head>
<svelte:window onmousemove={handleMouseMove} />
{#if $cursorVisible && cursorMoved}
	<img class="cursor" src="/img/cursor.svg" alt="" style="left: {cursorX}px; top: {cursorY}px; width: {cursorSizeValue}; height: {cursorSizeValue};" />
{/if}
<div class="page">
	<Header areaID="header" {onBack} />
	<Breadcrumb areaID="breadcrumb" items={$breadcrumbItems} {onBack} />
	<div class="content" bind:this={contentElement}>
		{#if $confirmDialog.visible && $confirmDialog.action && $confirmDialog.action !== 'back'}
			{@const dialogConfig = $confirmDialogs[$confirmDialog.action as 'restart' | 'shutdown' | 'quit']}
			<ConfirmDialog title={dialogConfig.title ?? ''} message={dialogConfig.message ?? ''} confirmLabel={dialogConfig.confirmLabel} cancelLabel={dialogConfig.cancelLabel} defaultButton={dialogConfig.defaultButton} onConfirm={handleConfirm} onBack={handleCancel} />
		{:else if $currentComponent}
			{@const Component = $currentComponent.component}
			<Component areaID="content" title={$currentComponent.label ?? ''} {...$currentComponent.props} {onBack} />
		{:else}
			<Menu areaID="content" title={$currentTitle ?? ''} items={$currentItems.map(i => ({ id: i.id, label: i.label ?? '', selected: i.selected?.() }))} orientation={$currentOrientation} selectedId={$selectedId} onselect={navigate} {onBack} />
		{/if}
	</div>
	{#if $footerVisible}
		<Footer />
	{/if}
</div>
