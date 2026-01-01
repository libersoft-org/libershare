<script lang="ts">
	import Menu from '../components/Menu/Menu.svelte';
	import { createNavigation } from '../scripts/navigation.ts';
	const { currentItems, currentComponent, currentTitle, currentOrientation, selectedId, navigate, goBack } = createNavigation();
</script>

<svelte:head>
	<title>LiberShare</title>
</svelte:head>

{#if $currentComponent}
	<svelte:component this={$currentComponent.component} title={$currentComponent.label} {...$currentComponent.props} onback={goBack} />
{:else}
	<Menu title={$currentTitle} items={$currentItems.map(i => ({ id: i.id, label: i.label }))} orientation={$currentOrientation} selectedId={$selectedId} onselect={navigate} onback={goBack} />
{/if}
