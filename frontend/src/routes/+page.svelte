<script lang="ts">
	import { onMount } from 'svelte';
	import Header from '../components/Header/Header.svelte';
	import NavigationBreadcrumb from '../components/Breadcrumb/NavigationBreadcrumb.svelte';
	import Menu from '../components/Menu/Menu.svelte';
	import Footer from '../components/Footer/Footer.svelte';
	import ConfirmDialog from '../components/Dialog/ConfirmDialog.svelte';
	import { createNavigation, breadcrumbItems, setContentElement, confirmDialog, hideConfirmDialog } from '../scripts/navigation.ts';
	import { confirmDialogs } from '../scripts/menu.ts';
	import { productName } from '../scripts/app.ts';
	import { startInput } from '../scripts/input/input.ts';
	import { api } from '../scripts/api.ts';
	import { activateArea } from '../scripts/areas.ts';
	import { LAYOUT, CONTENT_POSITIONS } from '../scripts/navigationLayout.ts';
	import { initAudio, play } from '../scripts/audio.ts';
	import { cursorVisible } from '../scripts/input/mouse.ts';
	import { cursorSize, cursorSizes, footerVisible } from '../scripts/settings.ts';
	import Debug from '../components/Debug/Debug.svelte';
	import { initStats } from '../scripts/stats.ts';
	import { initNetworks, networks } from '../scripts/networks.ts';
	const { currentItems, currentComponent, currentTitle, currentOrientation, selectedId, navigate, onBack: onBack } = createNavigation();
	let contentElement: HTMLElement;
	let cursorX = $state(0);
	let cursorY = $state(0);
	let cursorMoved = $state(false);
	let isTouchDevice = $state(false);
	let cursorSizeValue = $derived(cursorSizes[$cursorSize]);

	function handleMouseMove(e: MouseEvent) {
		if (isTouchDevice) return; // Ignore mouse events triggered by touch
		cursorX = e.clientX;
		cursorY = e.clientY;
		cursorMoved = true;
	}

	function handleTouchStart() {
		isTouchDevice = true;
		cursorMoved = false;
	}

	function handleConfirm() {
		if ($confirmDialog.action && $confirmDialog.action !== 'back') {
			play('exit');
			const dialogConfig = $confirmDialogs[$confirmDialog.action as 'restart' | 'shutdown' | 'quit'];
			if (dialogConfig) api.call(dialogConfig.apiAction);
		}
		hideConfirmDialog();
	}

	function handleCancel() {
		hideConfirmDialog();
	}

	onMount(async () => {
		// Content element for scroll management
		setContentElement(contentElement);
		startInput();
		activateArea('content');
		initAudio();
		play('welcome');
		try {
			await initNetworks();
			await initStats();
		} catch (error) {
			console.error('[App] Initialization error:', error);
		}
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
		background-color: var(--secondary-hard-background);
	}
</style>

<svelte:head>
	<title>{productName}</title>
</svelte:head>
<svelte:window onmousemove={handleMouseMove} ontouchstart={handleTouchStart} />
{#if $cursorVisible && cursorMoved && !isTouchDevice}
	<img class="cursor" src="/img/cursor.svg" alt="" style="left: {cursorX}px; top: {cursorY}px; width: {cursorSizeValue}; height: {cursorSizeValue};" />
{/if}
<div class="page">

	{JSON.stringify($networks)}

	<Header areaID="header" position={LAYOUT.header} {onBack} />
	<NavigationBreadcrumb areaID="breadcrumb" position={LAYOUT.breadcrumb} items={$breadcrumbItems} {onBack} />
	<div class="content" bind:this={contentElement}>
		{#if $confirmDialog.visible && $confirmDialog.action && $confirmDialog.action !== 'back'}
			{@const dialogConfig = $confirmDialogs[$confirmDialog.action as 'restart' | 'shutdown' | 'quit']}
			<ConfirmDialog title={dialogConfig.title ?? ''} message={dialogConfig.message ?? ''} confirmLabel={dialogConfig.confirmLabel} cancelLabel={dialogConfig.cancelLabel} defaultButton={dialogConfig.defaultButton} position={LAYOUT.content} onConfirm={handleConfirm} onBack={handleCancel} />
		{:else if $currentComponent}
			{@const Component = $currentComponent.component}
			<Component areaID="content" title={$currentComponent.label ?? ''} items={$currentItems.map(i => ({ id: i.id, label: i.label ?? '', icon: i.icon, iconPosition: i.iconPosition, iconSize: i.iconSize, noColorFilter: i.noColorFilter, selected: i.selected?.() }))} orientation={$currentOrientation} selectedId={$selectedId} position={LAYOUT.content} onselect={navigate} {...$currentComponent.props} {onBack} />
		{:else}
			<Menu areaID="content" title={$currentTitle ?? ''} items={$currentItems.map(i => ({ id: i.id, label: i.label ?? '', icon: i.icon, iconPosition: i.iconPosition, iconSize: i.iconSize, noColorFilter: i.noColorFilter, selected: i.selected?.() }))} orientation={$currentOrientation} selectedId={$selectedId} position={LAYOUT.content} buttonWidth="25vh" onselect={navigate} {onBack} />
		{/if}
	</div>
	{#if $footerVisible}
		<Footer />
	{/if}
</div>
<Debug />
