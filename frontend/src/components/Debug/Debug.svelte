<script lang="ts">
	import { areaLayout, activeArea, debugAreas } from '../../scripts/areas.ts';
	import { DEBUG_GRID_CELL_WIDTH, DEBUG_GRID_CELL_HEIGHT, DEBUG_GRID_PADDING, getDebugOverlayPosition, type GridBounds } from '../../scripts/debug.ts';

	// Calculate grid bounds
	let bounds = $derived.by<GridBounds>(() => {
		const positions = Object.values($areaLayout).filter(pos => pos.x > -100 && pos.x < 100 && pos.y > -100 && pos.y < 100);
		if (positions.length === 0) return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
		return {
			minX: Math.min(...positions.map(p => p.x)),
			maxX: Math.max(...positions.map(p => p.x)),
			minY: Math.min(...positions.map(p => p.y)),
			maxY: Math.max(...positions.map(p => p.y)),
		};
	});

	// Calculate position for each area in the overlay
	const getOverlayPosition = (pos: { x: number; y: number }) => getDebugOverlayPosition(pos, bounds);
</script>

<style>
	.debug-overlay {
		position: fixed;
		top: 10px;
		right: 10px;
		background: rgba(0, 0, 0, 0.9);
		border: 2px solid #444;
		border-radius: 8px;
		z-index: 99999;
		font-family: 'Consolas', 'Monaco', monospace;
		font-size: 11px;
		color: #fff;
		max-width: 90vw;
		max-height: 90vh;
		overflow: auto;
	}

	.debug-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 8px 12px;
		background: #333;
		border-bottom: 1px solid #444;
		gap: 20px;
	}

	.debug-title {
		font-weight: bold;
		color: #0ff;
	}

	.debug-info {
		color: #888;
	}

	.debug-grid {
		position: relative;
		min-width: 200px;
		min-height: 100px;
	}

	.debug-area {
		position: absolute;
		width: 110px;
		height: 32px;
		background: #2a2a4a;
		border: 1px solid #555;
		border-radius: 4px;
		display: flex;
		flex-direction: column;
		justify-content: center;
		align-items: center;
		transition:
			background 0.15s,
			border-color 0.15s,
			transform 0.15s;
	}

	.debug-area.active {
		background: #1a4a1a;
		border-color: #0f0;
		box-shadow: 0 0 10px rgba(0, 255, 0, 0.5);
		transform: scale(1.05);
	}

	.area-id {
		font-weight: bold;
		color: #fff;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 100px;
	}

	.debug-area.active .area-id {
		color: #0f0;
	}

	.area-pos {
		font-size: 9px;
		color: #888;
	}

	.debug-area.active .area-pos {
		color: #8f8;
	}
</style>

{#if $debugAreas}
	<div class="debug-overlay">
		<div class="debug-header">
			<span class="debug-title">Area Debug (F2 to toggle)</span>
			<span class="debug-info">Areas: {Object.keys($areaLayout).length} | Active: {$activeArea ?? 'none'}</span>
		</div>
		<div class="debug-grid" style="width: {GRID_PADDING * 2 + (bounds.maxX - bounds.minX + 1) * GRID_CELL_WIDTH}px; height: {GRID_PADDING * 2 + (bounds.maxY - bounds.minY + 1) * GRID_CELL_HEIGHT}px;">
			{#each Object.entries($areaLayout) as [areaID, pos]}
				{@const overlayPos = getOverlayPosition(pos)}
				{@const isActive = areaID === $activeArea}
				{@const isHidden = pos.x <= -100 || pos.x >= 100 || pos.y <= -100 || pos.y >= 100}
				{#if !isHidden}
					<div class="debug-area" class:active={isActive} style="left: {overlayPos.left}px; top: {overlayPos.top}px;" title="{areaID} ({pos.x}, {pos.y})">
						<span class="area-id">{areaID.length > 14 ? areaID.slice(0, 12) + '…' : areaID}</span>
						<span class="area-pos">({pos.x}, {pos.y})</span>
					</div>
				{/if}
			{/each}
		</div>
	</div>
{/if}
