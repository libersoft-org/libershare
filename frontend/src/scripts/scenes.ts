export type InputAction = 'up' | 'down' | 'left' | 'right' | 'confirmDown' | 'confirmUp' | 'confirmCancel' | 'back';
export type InputCallback = () => void;
export type InputHandlers = Partial<Record<InputAction, InputCallback>>;

class SceneManager {
	private scenes: Map<string, InputHandlers> = new Map();
	private activeScene: string | null = null;
	// Confirm state - tracks if confirm is "active" (not interrupted)
	private confirmActive = false;

	registerScene(sceneId: string, handlers: InputHandlers): () => void {
		this.scenes.set(sceneId, handlers);
		return () => this.unregisterScene(sceneId);
	}

	unregisterScene(sceneId: string): void {
		this.scenes.delete(sceneId);
		if (this.activeScene === sceneId) {
			this.activeScene = null;
		}
	}

	activateScene(sceneId: string): void {
		if (this.scenes.has(sceneId)) {
			this.activeScene = sceneId;
		}
	}

	deactivateScene(sceneId: string): void {
		if (this.activeScene === sceneId) {
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

export function registerScene(sceneId: string, handlers: InputHandlers): () => void {
	return getSceneManager().registerScene(sceneId, handlers);
}

export function unregisterScene(sceneId: string): void {
	getSceneManager().unregisterScene(sceneId);
}

export function activateScene(sceneId: string): void {
	getSceneManager().activateScene(sceneId);
}

export function deactivateScene(sceneId: string): void {
	getSceneManager().deactivateScene(sceneId);
}

export function emit(action: InputAction): void {
	getSceneManager().emit(action);
}
