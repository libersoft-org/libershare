// Grid dimensions for debug area visualization
export const DEBUG_GRID_CELL_WIDTH = 120;
export const DEBUG_GRID_CELL_HEIGHT = 40;
export const DEBUG_GRID_PADDING = 20;
export interface OverlayPosition {
	left: number;
	top: number;
}
export interface GridBounds {
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
}

// Calculate position for an area in the debug overlay
export function getDebugOverlayPosition(pos: { x: number; y: number }, bounds: GridBounds): OverlayPosition {
	const offsetX = pos.x - bounds.minX;
	const offsetY = pos.y - bounds.minY;
	return {
		left: DEBUG_GRID_PADDING + offsetX * DEBUG_GRID_CELL_WIDTH,
		top: DEBUG_GRID_PADDING + offsetY * DEBUG_GRID_CELL_HEIGHT,
	};
}
