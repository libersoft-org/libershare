<script lang="ts">
	import MainMenu from '../components/MainMenu.svelte';
	import Items from '../components/Items.svelte';
	import ExitMenu from '../components/ExitMenu.svelte';
	type Page = 'main' | 'storage' | 'movies' | 'series' | 'exit';
	let currentPage = $state<Page>('main');
	let pageHistory = $state<Page[]>([]);
	
	const mainMenuItems = [
		{ id: 'storage', label: 'Storage' },
		{ id: 'downloads', label: 'Downloads' },
		{ id: 'settings', label: 'Settings' },
		{ id: 'about', label: 'About' }
	];
	
	const storageMenuItems = [
		{ id: 'movies', label: 'Movies' },
		{ id: 'series', label: 'Series' },
		{ id: 'music', label: 'Music' }
	];
	
	function navigateTo(page: Page): void {
		pageHistory = [...pageHistory, currentPage];
		currentPage = page;
	}
	
	function goBack(): void {
		if (pageHistory.length > 0) {
			currentPage = pageHistory[pageHistory.length - 1];
			pageHistory = pageHistory.slice(0, -1);
		}
	}
	
	function handleMainMenuSelect(selectedId: string): void {
		if (selectedId === 'storage') navigateTo('storage');
	}
	
	function handleStorageMenuSelect(selectedId: string): void {
		if (selectedId === 'movies') navigateTo('movies');
		else if (selectedId === 'series') navigateTo('series');
	}
	
	function handleExitMenuSelect(selectedId: string): void {
		// TODO: Implement functionality
		console.log('Exit menu selected:', selectedId);
	}
</script>

<svelte:head>
	<title>LiberShare</title>
</svelte:head>
{#if currentPage === 'main'}
	<MainMenu 
		title="LiberShare" 
		items={mainMenuItems} 
		onselect={handleMainMenuSelect}
		onback={() => navigateTo('exit')}
	/>
{:else if currentPage === 'exit'}
	<ExitMenu 
		onselect={handleExitMenuSelect}
		onback={() => currentPage = 'main'}
	/>
{:else if currentPage === 'storage'}
	<MainMenu 
		title="Storage" 
		items={storageMenuItems} 
		onselect={handleStorageMenuSelect}
		onback={goBack}
	/>
{:else if currentPage === 'movies'}
	<Items title="Movies" onback={goBack} />
{:else if currentPage === 'series'}
	<Items title="Series" onback={goBack} />
{/if}
