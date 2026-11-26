import { describe, expect, it } from 'bun:test';
import { mergeGamepads } from '../../src/scripts/input/gamepad-merge.ts';

function pad(pressed: number[], axes: number[] = [0, 0], buttonCount = 17): { buttons: { pressed: boolean }[]; axes: number[] } {
	return { buttons: Array.from({ length: buttonCount }, (_, i) => ({ pressed: pressed.includes(i) })), axes };
}

describe('merging the state of several gamepads', () => {
	it('takes a button held on any gamepad, not only on the first one', () => {
		const { buttons } = mergeGamepads([pad([]), pad([0, 13])]);
		expect(buttons[0]).toBe(true);
		expect(buttons[13]).toBe(true);
		expect(buttons[1]).toBe(false);
	});

	it('takes the strongest stick deflection, whichever gamepad it comes from', () => {
		expect(mergeGamepads([pad([], [0.1, -0.2]), pad([], [-0.9, 0.05])])).toMatchObject({ stickX: -0.9, stickY: -0.2 });
	});

	it('copes with gamepads that report a different number of buttons and axes', () => {
		const { buttons, stickX, stickY } = mergeGamepads([pad([1], [], 4), pad([15], [0.5, 0.5])]);
		expect(buttons.length).toBe(17);
		expect(buttons[1]).toBe(true);
		expect(buttons[15]).toBe(true);
		expect([stickX, stickY]).toEqual([0.5, 0.5]);
	});

	it('gives an idle state when no gamepad is left', () => {
		expect(mergeGamepads([])).toEqual({ buttons: [], stickX: 0, stickY: 0 });
	});
});
