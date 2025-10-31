/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


const layout = distributeFlexBoxLayout(1000, {
	spaceBefore: { min: 10, max: 100, priority: 2, share: 1 },
	content: [{ min: 50, max: 100, priority: 2, share: 2 }, { min: 100, max: 500, priority: 1 }],
	spaceAfter: {},
});

export interface IFlexBoxPart {
	width?: number;
	min?: number;
	max?: number;
	priority?: number;
	share?: number;
}

/**
 * Distributes a total size into parts defined by min, max and growPriority.
 * Returns `null` if the layout is not possible.
 * The sum of all returned sizes will be equal to `totalSize`.
 *
 * First, each items gets its minimum size from any priority.
 * Then, remaining space is distributed to items with the highest priority, as long as the max constraint allows it (considering share).
 * This continues with next lower priorities until no space is left.
 *
 * If the sum of all minimum sizes exceeds `totalSize`, `null` is returned.
 * If the sum of all maximum sizes is less than `totalSize`, `null` is also returned.
 *
 * The default for min is 0, for max is Infinity, for priority is 0, for share is 1.
 *
*/
export function distributeFlexBoxLayout<T extends Record<string, IFlexBoxPart | IFlexBoxPart[]>>(
	totalSize: number,
	parts: T & Record<string, IFlexBoxPart | IFlexBoxPart[]>
): Record<keyof T, number> | null {
	// Flatten all parts into an array with tracking info
	interface FlatPart {
		key: keyof T;
		index?: number; // for array parts
		min: number;
		max: number;
		priority: number;
		share: number;
		allocatedSize: number;
	}

	const flatParts: FlatPart[] = [];
	for (const key in parts) {
		const part = parts[key];
		if (Array.isArray(part)) {
			for (let i = 0; i < part.length; i++) {
				flatParts.push({
					key,
					index: i,
					min: part[i].min ?? 0,
					max: part[i].max ?? Infinity,
					priority: part[i].priority ?? 0,
					share: part[i].share ?? 1,
					allocatedSize: 0
				});
			}
		} else {
			flatParts.push({
				key,
				min: part.min ?? 0,
				max: part.max ?? Infinity,
				priority: part.priority ?? 0,
				share: part.share ?? 1,
				allocatedSize: 0
			});
		}
	}

	// Check if minimum sizes exceed total
	const totalMin = flatParts.reduce((sum, p) => sum + p.min, 0);
	if (totalMin > totalSize) {
		return null;
	}

	// Check if maximum sizes are less than total
	const totalMax = flatParts.reduce((sum, p) => sum + p.max, 0);
	if (totalMax < totalSize) {
		return null;
	}

	// Allocate minimum sizes first
	for (const part of flatParts) {
		part.allocatedSize = part.min;
	}

	let remainingSize = totalSize - totalMin;

	// Get unique priorities in descending order
	const priorities = Array.from(new Set(flatParts.map(p => p.priority))).sort((a, b) => b - a);

	// Distribute remaining space by priority
	for (const priority of priorities) {
		if (remainingSize <= 0) {
			break;
		}

		const partsAtPriority = flatParts.filter(p => p.priority === priority);
		const totalShare = partsAtPriority.reduce((sum, p) => sum + p.share, 0);

		if (totalShare === 0) {
			continue;
		}

		// Calculate how much each part wants based on its share
		let spaceToDistribute = remainingSize;
		let iterationCount = 0;
		const maxIterations = partsAtPriority.length * 2; // Prevent infinite loops

		while (spaceToDistribute > 0.001 && iterationCount < maxIterations) {
			iterationCount++;
			let distributedThisRound = 0;
			let activeShare = 0;

			// Calculate active share (parts that haven't reached max)
			for (const part of partsAtPriority) {
				if (part.allocatedSize < part.max) {
					activeShare += part.share;
				}
			}

			if (activeShare === 0) {
				break;
			}

			for (const part of partsAtPriority) {
				if (part.allocatedSize >= part.max) {
					continue;
				}

				const shareRatio = part.share / activeShare;
				const desiredIncrease = spaceToDistribute * shareRatio;
				const maxIncrease = part.max - part.allocatedSize;
				const actualIncrease = Math.min(desiredIncrease, maxIncrease);

				part.allocatedSize += actualIncrease;
				distributedThisRound += actualIncrease;
			}

			spaceToDistribute -= distributedThisRound;

			if (distributedThisRound < 0.001) {
				break;
			}
		}

		remainingSize = spaceToDistribute;
	}

	// Build result object
	const result: any = {};
	for (const key in parts) {
		const part = parts[key];
		if (Array.isArray(part)) {
			const sizes = flatParts
				.filter(p => p.key === key)
				.map(p => p.allocatedSize);
			result[key] = sizes.reduce((sum, size) => sum + size, 0);
		} else {
			const flatPart = flatParts.find(p => p.key === key && p.index === undefined);
			result[key] = flatPart!.allocatedSize;
		}
	}

	return result;
}
