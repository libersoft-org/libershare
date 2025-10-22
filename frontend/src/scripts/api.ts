export async function getAPI(url: string): Promise<any> {
	try {
		const response = await fetch(url);
		if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
		const data = await response.json();
		return data;
	} catch (error) {
		console.error(`API request failed for ${url}:`, error);
		throw error;
	}
}

export async function getAPILocal(apiName: string): Promise<any> {
	return getAPI('http://127.0.0.1/api/' + apiName);
}
