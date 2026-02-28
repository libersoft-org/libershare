// Back handler stack
type BackHandler = () => void;
const backStack: BackHandler[] = [];

export function pushBackHandler(handler: BackHandler): () => void {
	backStack.push(handler);
	return () => {
		const index = backStack.indexOf(handler);
		if (index !== -1) backStack.splice(index, 1);
	};
}

export function popBackHandler(): BackHandler | undefined {
	return backStack.pop();
}

export function hasBackHandler(): boolean {
	return backStack.length > 0;
}

export function executeBackHandler(): boolean {
	if (backStack.length > 0) {
		const handler = backStack[backStack.length - 1]!;
		handler();
		return true;
	}
	return false;
}
