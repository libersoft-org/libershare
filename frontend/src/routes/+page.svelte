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
		setContentElement(contentElement);
		startInput();
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
		flex: 1;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
	}
</style>

<svelte:head>
	<title>{productName}</title>
</svelte:head>

<div class="page">
	<Header {onBack} />
	<Breadcrumb items={$breadcrumbItems} />
	<div class="content" bind:this={contentElement}>
		{#if $confirmDialog.visible && $confirmDialog.action}
			{@const dialogConfig = confirmDialogs[$confirmDialog.action]}
			<ConfirmDialog title={dialogConfig.title} message={dialogConfig.message} confirmLabel={dialogConfig.confirmLabel} cancelLabel={dialogConfig.cancelLabel} defaultButton={dialogConfig.defaultButton} onConfirm={handleConfirm} onBack={handleCancel} />
		{:else if $currentComponent}
			<svelte:component this={$currentComponent.component} title={$currentComponent.label} {...$currentComponent.props} {onBack} />
		{:else}
			<Menu title={$currentTitle} items={$currentItems.map(i => ({ id: i.id, label: i.label }))} orientation={$currentOrientation} selectedId={$selectedId} onselect={navigate} {onBack} />
		{/if}
	</div>
	<Footer />
</div>
