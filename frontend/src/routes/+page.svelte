<script lang="ts">
	import { onMount } from 'svelte';
	import Header from '../components/Header/Header.svelte';
	import Breadcrumb from '../components/Breadcrumb/Breadcrumb.svelte';
	import Menu from '../components/Menu/Menu.svelte';
	import Footer from '../components/Footer/Footer.svelte';
	import { createNavigation, breadcrumbItems, setContentElement } from '../scripts/navigation.ts';
	import { productName } from '../scripts/app.ts';
	import { startInput } from '../scripts/input.ts';
	const { currentItems, currentComponent, currentTitle, currentOrientation, selectedId, navigate, goBack } = createNavigation();

	let contentElement: HTMLElement;

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
	<Header onback={goBack} />
	<Breadcrumb items={$breadcrumbItems} />
	<div class="content" bind:this={contentElement}>
		{#if $currentComponent}
			<svelte:component this={$currentComponent.component} title={$currentComponent.label} {...$currentComponent.props} onback={goBack} />
		{:else}
			<Menu title={$currentTitle} items={$currentItems.map(i => ({ id: i.id, label: i.label }))} orientation={$currentOrientation} selectedId={$selectedId} onselect={navigate} onback={goBack} />
		{/if}
	</div>
	<Footer />
</div>
