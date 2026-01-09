<script lang="ts">
	import { onMount } from 'svelte';
	import Header from '../components/Header/Header.svelte';
	import Breadcrumb from '../components/Breadcrumb/Breadcrumb.svelte';
	import Menu from '../components/Menu/Menu.svelte';
	import Footer from '../components/Footer/Footer.svelte';
	import ConfirmDialog from '../components/Dialog/ConfirmDialog.svelte';
	import { createNavigation, breadcrumbItems, setContentElement, confirmDialog, confirmDialogs, hideConfirmDialog } from '../scripts/navigation.ts';
	import { productName } from '../scripts/app.ts';
	import { startInput } from '../scripts/input.ts';
	import { getAPILocal } from '../scripts/api.ts';
	import { setAreaPosition, useArea, activateArea, activeArea } from '../scripts/areas.ts';
	const { currentItems, currentComponent, currentTitle, currentOrientation, selectedId, navigate, onBack: onBack } = createNavigation();
	let contentElement: HTMLElement;

	function handleConfirm() {
		if ($confirmDialog.action) {
			const dialogConfig = confirmDialogs[$confirmDialog.action];
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
		setAreaPosition('left', { x: 0, y: 1 });
		setAreaPosition('content', { x: 1, y: 1 });
		setAreaPosition('right', { x: 2, y: 1 });

		// Setup handlers for simple areas (left/right sidebars)
		const unregisterLeft = useArea('left', {});
		const unregisterRight = useArea('right', {});

		setContentElement(contentElement);
		startInput();
		activateArea('content');

		return () => {
			unregisterLeft();
			unregisterRight();
		};
	});
</script>

<style>
	.page {
		display: flex;
		flex-direction: column;
		height: 100vh;
		overflow: hidden;
	}

	.content {
		display: flex;
		flex-direction: row;
		flex: 1;
		overflow-y: auto;
	}

	.left {
		width: 20vh;
		height: 100%;
		background-color: red;
	}

	.left.selected {
		background-color: green;
	}

	.right {
		width: 20vh;
		height: 100%;
		background-color: red;
	}

	.right.selected {
		background-color: green;
	}
</style>

<svelte:head>
	<title>{productName}</title>
</svelte:head>

<div class="page">
	<Header areaID="header" {onBack} />
	<Breadcrumb items={$breadcrumbItems} />
	<div class="content" bind:this={contentElement}>
		<div class="left" class:selected={$activeArea === 'left'}>aaa</div>
		{#if $confirmDialog.visible && $confirmDialog.action}
			{@const dialogConfig = confirmDialogs[$confirmDialog.action]}
			<ConfirmDialog title={dialogConfig.title} message={dialogConfig.message} confirmLabel={dialogConfig.confirmLabel} cancelLabel={dialogConfig.cancelLabel} defaultButton={dialogConfig.defaultButton} onConfirm={handleConfirm} onBack={handleCancel} />
		{:else if $currentComponent}
			<svelte:component this={$currentComponent.component} areaID="content" title={$currentComponent.label} {...$currentComponent.props} {onBack} />
		{:else}
			<Menu areaID="content" title={$currentTitle} items={$currentItems.map(i => ({ id: i.id, label: i.label }))} orientation={$currentOrientation} selectedId={$selectedId} onselect={navigate} {onBack} />
		{/if}
		<div class="right" class:selected={$activeArea === 'right'}>bbb</div>
	</div>
	<Footer />
</div>
