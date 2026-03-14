export interface HLC {
	wallTime: number;
	logical: number;
	nodeID: string;
}

export function hlcCompare(a: HLC, b: HLC): number {
	if (a.wallTime !== b.wallTime) return a.wallTime - b.wallTime;
	if (a.logical !== b.logical) return a.logical - b.logical;
	return a.nodeID.localeCompare(b.nodeID);
}

export function hlcTick(local: HLC): HLC {
	const now = Date.now();
	if (now > local.wallTime) {
		return { wallTime: now, logical: 0, nodeID: local.nodeID };
	}
	return { wallTime: local.wallTime, logical: local.logical + 1, nodeID: local.nodeID };
}

export function hlcMerge(local: HLC, remote: HLC): HLC {
	const now = Date.now();
	const maxWall = Math.max(now, local.wallTime, remote.wallTime);
	if (maxWall === now && now > local.wallTime && now > remote.wallTime) {
		return { wallTime: now, logical: 0, nodeID: local.nodeID };
	}
	if (maxWall === local.wallTime && local.wallTime === remote.wallTime) {
		return { wallTime: maxWall, logical: Math.max(local.logical, remote.logical) + 1, nodeID: local.nodeID };
	}
	if (maxWall === local.wallTime) {
		return { wallTime: maxWall, logical: local.logical + 1, nodeID: local.nodeID };
	}
	return { wallTime: maxWall, logical: remote.logical + 1, nodeID: local.nodeID };
}
