export type InputAction = 'up' | 'down' | 'left' | 'right' | 'confirmDown' | 'confirmUp' | 'confirmCancel' | 'back';
export type InputCallback = () => void;
export type InputHandlers = Partial<Record<InputAction, InputCallback>>;

class SceneManager {
	private scenes: Map<string, InputHandlers> = new Map();
	private activeScene: string | null = null;
	// Confirm state - tracks if confirm is "active" (not interrupted)
	private confirmActive = false;

	registerScene(sceneID: string, handlers: InputHandlers): () => void {
		this.scenes.set(sceneID, handlers);
		return () => this.unregisterScene(sceneID);
	}

	unregisterScene(sceneID: string): void {
		this.scenes.delete(sceneID);
		if (this.activeScene === sceneID) {
			this.activeScene = null;
		}
	}

	activateScene(sceneID: string): void {
		if (this.scenes.has(sceneID)) {
			this.activeScene = sceneID;
		}
	}

	deactivateScene(sceneID: string): void {
		if (this.activeScene === sceneID) {
			this.activeScene = null;
		}
	}

	getActiveScene(): string | null {
		return this.activeScene;
	}

	emit(action: InputAction): void {
		if (!this.activeScene) return;
		const handlers = this.scenes.get(this.activeScene);

		// Handle confirm state
		if (action === 'confirmDown') {
			this.confirmActive = true;
		} else if (action === 'confirmUp') {
			if (!this.confirmActive) return; // Interrupted, don't fire confirmUp
			this.confirmActive = false;
		} else if (action === 'confirmCancel') {
			this.confirmActive = false;
		} else {
			// Any other action cancels the confirm - trigger confirmCancel to reset animation
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

export function emit(action: InputAction): void {
	getSceneManager().emit(action);
}
