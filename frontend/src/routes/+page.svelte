<script lang="ts">
	import Header from '../components/Header/Header.svelte';
	import Menu from '../components/Menu/Menu.svelte';
	import Footer from '../components/Footer/Footer.svelte';
	import { createNavigation } from '../scripts/navigation.ts';
	import { productName } from '../scripts/app.ts';
	const { currentItems, currentComponent, currentTitle, currentOrientation, selectedId, navigate, goBack } = createNavigation();
</script>

<style>
	.page {
		display: flex;
		flex-direction: column;
		min-height: 100vh;
	}
</style>

<svelte:head>
	<title>{productName}</title>
</svelte:head>

<div class="page">
	<Header />
	{#if $currentComponent}
		<svelte:component this={$currentComponent.component} title={$currentComponent.label} {...$currentComponent.props} onback={goBack} />
	{:else}
		<Menu title={$currentTitle} items={$currentItems.map(i => ({ id: i.id, label: i.label }))} orientation={$currentOrientation} selectedId={$selectedId} onselect={navigate} onback={goBack} />
	{/if}
	<Footer />
</div>
