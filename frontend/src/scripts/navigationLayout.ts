// Centralized layout positions for spatial navigation
// All positions are defined here to ensure consistency across the application
export type Position = { x: number; y: number };
// Main layout areas - these are the "anchor" positions
export const LAYOUT = {
	// Top-level areas
	header: { x: 0, y: 0 },
	breadcrumb: { x: 0, y: 1 },
	// Content area base position
	content: { x: 0, y: 2 },
} as const;
// Content sub-area offsets (relative to LAYOUT.content)
// These are added to the content base position
export const CONTENT_OFFSETS = {
	// Path breadcrumb (above toolbar)
	pathBreadcrumb: { x: 0, y: 0.05 },
	// Top section (search bars, toolbars, path breadcrumbs)
	top: { x: 0, y: 0.1 },
	// Main content area (lists, grids, file browsers)
	main: { x: 0, y: 0.2 },
	// Side panel (actions, details)
	side: { x: 1, y: 0.2 },
	// Bottom section (pagination, actions)
	bottom: { x: 0, y: 0.9 },
} as const;

// Helper to calculate absolute position from content base + offset
export function contentPosition(offset: Position): Position {
	return {
		x: LAYOUT.content.x + offset.x,
		y: LAYOUT.content.y + offset.y,
	};
}

// Predefined content positions for common use cases
export const CONTENT_POSITIONS = {
	pathBreadcrumb: contentPosition(CONTENT_OFFSETS.pathBreadcrumb),
	top: contentPosition(CONTENT_OFFSETS.top),
	main: contentPosition(CONTENT_OFFSETS.main),
	side: contentPosition(CONTENT_OFFSETS.side),
	bottom: contentPosition(CONTENT_OFFSETS.bottom),
} as const;
