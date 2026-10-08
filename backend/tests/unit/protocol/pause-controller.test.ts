import { describe, expect, it } from 'bun:test';
import { ErrorCodes } from '@shared';
import { PauseController } from '../../../src/protocol/pause-controller.ts';

describe('PauseController.stopSignal', () => {
	it('aborts when the owner is disabled and hands out a fresh signal once it is enabled again', () => {
		let disabled = false;
		const controller = new PauseController(
			() => disabled,
			() => false
		);
		const running = controller.stopSignal();
		expect(running.aborted).toBe(false);
		disabled = true;
		controller.notifyStateChange();
		expect(running.aborted).toBe(true);
		expect((running.reason as { code?: string }).code).toBe(ErrorCodes.DOWNLOAD_CANCELLED);
		disabled = false;
		controller.notifyStateChange();
		const again = controller.stopSignal();
		expect(again).not.toBe(running);
		expect(again.aborted).toBe(false);
	});

	it('returns an aborted signal while the owner is stopped, even before it was notified', () => {
		const controller = new PauseController(
			() => false,
			() => true
		);
		expect(controller.stopSignal().aborted).toBe(true);
	});

	it('keeps the same signal while the owner keeps running', () => {
		const controller = new PauseController(
			() => false,
			() => false
		);
		const first = controller.stopSignal();
		controller.notifyStateChange();
		expect(controller.stopSignal()).toBe(first);
	});
});
