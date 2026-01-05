import { writable } from 'svelte/store';

export type InputAction = 'up' | 'down' | 'left' | 'right' | 'confirmDown' | 'confirmUp' | 'confirmCancel' | 'back';
export type InputCallback = () => void;
export type InputHandlers = Partial<Record<InputAction, InputCallback>>;
interface SceneEntry {
	handlers: InputHandlers;
	order: number;
}
const activeSceneStore = writable<string | null>(null);
export const activeScene = { subscribe: activeSceneStore.subscribe };

class SceneManager {
	private scenes: Map<string, SceneEntry> = new Map();
	private activeSceneId: string | null = null;
	private confirmActive = false;
	private nextOrder = 0;

	registerScene(sceneID: string, handlers: InputHandlers): () => void {
		this.scenes.set(sceneID, { handlers, order: this.nextOrder++ });
		return () => this.unregisterScene(sceneID);
	}

	unregisterScene(sceneID: string): void {
		this.scenes.delete(sceneID);
		if (this.activeSceneId === sceneID) {
			this.activeSceneId = null;
			activeSceneStore.set(null);
		}
	}

	activateScene(sceneID: string): void {
		if (this.scenes.has(sceneID)) {
			this.activeSceneId = sceneID;
			activeSceneStore.set(sceneID);
		}
	}

	deactivateScene(sceneID: string): void {
		if (this.activeSceneId === sceneID) {
			this.activeSceneId = null;
			activeSceneStore.set(null);
		}
	}

	getActiveScene(): string | null {
		return this.activeSceneId;
	}

	activatePrevScene(): boolean {
		if (!this.activeSceneId) return false;
		const currentEntry = this.scenes.get(this.activeSceneId);
		if (!currentEntry) return false;
		let prevScene: string | null = null;
		let prevOrder = -1;
		for (const [id, entry] of this.scenes) {
			if (entry.order < currentEntry.order && entry.order > prevOrder) {
				prevScene = id;
				prevOrder = entry.order;
			}
		}
		if (prevScene) {
			this.activeSceneId = prevScene;
			activeSceneStore.set(prevScene);
			return true;
		}
		return false;
	}

	activateNextScene(): boolean {
		if (!this.activeSceneId) return false;
		const currentEntry = this.scenes.get(this.activeSceneId);
		if (!currentEntry) return false;
		let nextScene: string | null = null;
		let nextOrder = Infinity;
		for (const [id, entry] of this.scenes) {
			if (entry.order > currentEntry.order && entry.order < nextOrder) {
				nextScene = id;
				nextOrder = entry.order;
			}
		}
		if (nextScene) {
			this.activeSceneId = nextScene;
			activeSceneStore.set(nextScene);
			return true;
		}
		return false;
	}

	emit(action: InputAction): void {
		if (!this.activeSceneId) return;
		const entry = this.scenes.get(this.activeSceneId);
		const handlers = entry?.handlers;

		// Handle confirm state
		if (action === 'confirmDown') this.confirmActive = true;
		else if (action === 'confirmUp') {
			if (!this.confirmActive) return;
			this.confirmActive = false;
		} else if (action === 'confirmCancel') this.confirmActive = false;
		else {
			if (this.confirmActive) {
				this.confirmActive = false;
				const cancelCallback = handlers?.['confirmCancel'];
				if (cancelCallback) cancelCallback();
			}
		}
		const callback = handlers?.[action];
		if (callback) callback();
	}
}

let globalSceneManager: SceneManager | null = null;

export function getSceneManager(): SceneManager {
	if (!globalSceneManager) globalSceneManager = new SceneManager();
	return globalSceneManager;
}

export function registerScene(sceneID: string, handlers: InputHandlers): () => void {
	return getSceneManager().registerScene(sceneID, handlers);
}

export function unregisterScene(sceneID: string): void {
	getSceneManager().unregisterScene(sceneID);
}

export function activateScene(sceneID: string): void {
	getSceneManager().activateScene(sceneID);
}

export function deactivateScene(sceneID: string): void {
	getSceneManager().deactivateScene(sceneID);
}

export function activatePrevScene(): boolean {
	return getSceneManager().activatePrevScene();
}

export function activateNextScene(): boolean {
	return getSceneManager().activateNextScene();
}

export function emit(action: InputAction): void {
	getSceneManager().emit(action);
}
