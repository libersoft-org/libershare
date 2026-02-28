<script lang="ts">
	import { onMount } from 'svelte';
	import { createNavigation, breadcrumbItems, setContentElement, confirmDialog, hideConfirmDialog } from '../scripts/navigation.ts';
	import { confirmDialogs } from '../scripts/menu.ts';
	import { productName } from '@shared';
	import { startInput } from '../scripts/input/input.ts';
	import { api } from '../scripts/api.ts';
	import { activateArea } from '../scripts/areas.ts';
	import { LAYOUT } from '../scripts/navigationLayout.ts';
	import { initAudio, play } from '../scripts/audio.ts';
	import { cursorVisible } from '../scripts/input/mouse.ts';
	import { cursorSize, cursorSizes, footerVisible, loadSettings } from '../scripts/settings.ts';
	import { connected, apiURL } from '../scripts/ws-client.ts';
	const { currentItems, currentComponent, currentTitle, currentOrientation, selectedId, navigate, onBack: onBack } = createNavigation();
	import Debug from '../components/Debug/Debug.svelte';
	import Header from '../pages/Header/Header.svelte';
	import NavigationBreadcrumb from '../components/Breadcrumb/NavigationBreadcrumb.svelte';
	import Menu from '../components/Menu/Menu.svelte';
	import Footer from '../pages/Footer/Footer.svelte';
	import ConfirmDialog from '../components/Dialog/ConfirmDialog.svelte';
	import SplashWelcome from '../pages/Splash/SplashWelcome.svelte';
	import SplashExit from '../pages/Splash/SplashExit.svelte';
	let contentElement: HTMLElement = $state(null!);
	let cursorX = $state(0);
	let cursorY = $state(0);
	let cursorMoved = $state(false);
	let isTouchDevice = $state(false);
	let exitAction = $state<'restart' | 'shutdown' | 'quit' | null>(null);
	let cursorSizeValue = $derived(cursorSizes[$cursorSize]);

	function handleMouseMove(e: MouseEvent): void {
		if (isTouchDevice) return; // Ignore mouse events triggered by touch
		cursorX = e.clientX;
		cursorY = e.clientY;
		cursorMoved = true;
	}

	function handleTouchStart(): void {
		isTouchDevice = true;
		cursorMoved = false;
	}

	async function handleConfirm(): Promise<void> {
		if ($confirmDialog.action && $confirmDialog.action !== 'back') {
			const action = $confirmDialog.action as 'restart' | 'shutdown' | 'quit';
			hideConfirmDialog();
			exitAction = action;
			await play('exit');
			if ((window as any).__TAURI_INTERNALS__) {
				const { invoke } = (window as any).__TAURI_INTERNALS__;
				const tauriCommands: Record<string, string> = { quit: 'app_quit', restart: 'app_restart', shutdown: 'app_shutdown' };
				if (tauriCommands[action]) invoke(tauriCommands[action]);
			} else {
				const dialogConfig = $confirmDialogs[action];
				if (dialogConfig) api.call(dialogConfig.apiAction).catch(() => console.error(`[App] Action '${action}' is supported in native application only`));
			}
			return;
		}
		hideConfirmDialog();
	}

	function handleCancel(): void {
		hideConfirmDialog();
	}

	async function onConnected(): Promise<void> {
		try {
			await loadSettings();
			play('welcome');
			console.log(await api.lishnets.list());
		} catch (error) {
			console.error('[App] Backend initialization error:', error);
		}
	}

	onMount(() => {
		// Initialize local systems (don't need backend)
		setContentElement(contentElement);
		startInput();
		activateArea('content');
		initAudio();
		// Call onConnected when backend connects
		const unsubscribe = connected.subscribe(isConnected => {
			if (isConnected) onConnected();
		});
		return unsubscribe;
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
		overflow-anchor: none;
		background-color: var(--secondary-hard-background);
	}
</style>

<svelte:head>
	<title>{productName}</title>
</svelte:head>
<svelte:window onmousemove={handleMouseMove} ontouchstart={handleTouchStart} />

{#if exitAction}
	<SplashExit action={exitAction} />
{:else if !$connected}
	<SplashWelcome url={apiURL} />
{:else}
	{#if $cursorVisible && cursorMoved && !isTouchDevice}
		<img class="cursor" src="/img/cursor.svg" alt="" style="left: {cursorX}px; top: {cursorY}px; width: {cursorSizeValue}; height: {cursorSizeValue};" />
	{/if}
	<div class="page">
		<Header areaID="header" position={LAYOUT.header} {onBack} />
		<NavigationBreadcrumb areaID="breadcrumb" position={LAYOUT.breadcrumb} items={$breadcrumbItems} {onBack} />
		<div class="content" data-content-scroll bind:this={contentElement}>
			{#if $confirmDialog.visible && $confirmDialog.action && $confirmDialog.action !== 'back'}
				{@const dialogConfig = $confirmDialogs[$confirmDialog.action as 'restart' | 'shutdown' | 'quit']}
				<ConfirmDialog title={dialogConfig.title ?? ''} message={dialogConfig.message ?? ''} confirmLabel={dialogConfig.confirmLabel} cancelLabel={dialogConfig.cancelLabel} position={LAYOUT.content} onConfirm={handleConfirm} onBack={handleCancel} />
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
{/if}
