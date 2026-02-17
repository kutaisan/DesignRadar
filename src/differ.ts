/**
 * TOON Diff Engine
 * Compares two filtered file snapshots and produces structured changes
 */

import deepDiffLib from 'deep-diff';
const deepDiff = deepDiffLib.diff;
import type { FilteredFile, FilteredPage } from './toon-converter.js';

export type ChangeKind = 'ADDED' | 'REMOVED' | 'MODIFIED';

export interface DesignChange {
    kind: ChangeKind;
    page: string;
    path: string;       // Human-readable path: "Header / Login Button"
    property: string;   // What changed: "fills", "characters", "bounds", etc.
    oldValue?: any;
    newValue?: any;
    summary: string;    // Short description: "backgroundColor: #FF0000 → #00FF00"
}

// ─── Build a map of nodes by ID for easy lookup ───

function buildNodeMap(
    nodes: Record<string, any>[],
    parentPath: string = ''
): Map<string, { node: Record<string, any>; path: string }> {
    const map = new Map<string, { node: Record<string, any>; path: string }>();

    for (const node of nodes) {
        const currentPath = parentPath ? `${parentPath} / ${node.name || node.id}` : (node.name || node.id);
        map.set(node.id, { node, path: currentPath });

        if (node.children && Array.isArray(node.children)) {
            const childMap = buildNodeMap(node.children, currentPath);
            for (const [id, entry] of childMap) {
                map.set(id, entry);
            }
        }
    }

    return map;
}

// ─── Compare two nodes' properties ───

function compareNodes(
    oldNode: Record<string, any>,
    newNode: Record<string, any>,
    path: string,
    pageName: string
): DesignChange[] {
    const changes: DesignChange[] = [];

    // Get all property keys (excluding "children" — handled at tree level)
    const allKeys = new Set([
        ...Object.keys(oldNode).filter(k => k !== 'children'),
        ...Object.keys(newNode).filter(k => k !== 'children'),
    ]);

    for (const key of allKeys) {
        const oldVal = oldNode[key];
        const newVal = newNode[key];

        // Skip ID and name (used for identification, not as changes)
        if (key === 'id') continue;

        // Name change IS a change worth reporting
        if (key === 'name' && oldVal !== newVal) {
            changes.push({
                kind: 'MODIFIED',
                page: pageName,
                path,
                property: 'name',
                oldValue: oldVal,
                newValue: newVal,
                summary: `Renamed: "${oldVal}" → "${newVal}"`,
            });
            continue;
        }
        if (key === 'name') continue;

        // Property added
        if (oldVal === undefined && newVal !== undefined) {
            changes.push({
                kind: 'ADDED',
                page: pageName,
                path,
                property: key,
                newValue: newVal,
                summary: `${key} added: ${formatValue(newVal)}`,
            });
            continue;
        }

        // Property removed
        if (oldVal !== undefined && newVal === undefined) {
            changes.push({
                kind: 'REMOVED',
                page: pageName,
                path,
                property: key,
                oldValue: oldVal,
                summary: `${key} removed (was: ${formatValue(oldVal)})`,
            });
            continue;
        }

        // Property changed (deep comparison)
        const diffs = deepDiff(oldVal, newVal);
        if (diffs && diffs.length > 0) {
            changes.push({
                kind: 'MODIFIED',
                page: pageName,
                path,
                property: key,
                oldValue: oldVal,
                newValue: newVal,
                summary: `${key}: ${formatValue(oldVal)} → ${formatValue(newVal)}`,
            });
        }
    }

    return changes;
}

// ─── Format a value for human display ───

function formatValue(val: any): string {
    if (val === null || val === undefined) return 'none';
    if (typeof val === 'string') return val;
    if (typeof val === 'number' || typeof val === 'boolean') return String(val);
    if (Array.isArray(val)) {
        // For fills, show colors
        if (val.length > 0 && val[0]?.color) {
            return val.map((f: any) => f.color).join(', ');
        }
        return JSON.stringify(val);
    }
    if (typeof val === 'object') {
        // Bounds
        if ('w' in val && 'h' in val) return `${val.w}×${val.h} at (${val.x},${val.y})`;
        return JSON.stringify(val);
    }
    return String(val);
}

// ─── Diff two page snapshots ───

function diffPage(oldPage: FilteredPage, newPage: FilteredPage): DesignChange[] {
    const changes: DesignChange[] = [];
    const pageName = newPage.name || oldPage.name;

    const oldMap = buildNodeMap(oldPage.children);
    const newMap = buildNodeMap(newPage.children);

    // Find modified and removed nodes
    for (const [id, oldEntry] of oldMap) {
        const newEntry = newMap.get(id);
        if (!newEntry) {
            // Node removed
            changes.push({
                kind: 'REMOVED',
                page: pageName,
                path: oldEntry.path,
                property: 'node',
                oldValue: oldEntry.node.type,
                summary: `"${oldEntry.node.name || id}" (${oldEntry.node.type}) removed`,
            });
        } else {
            // Node exists in both — compare properties
            const nodeChanges = compareNodes(oldEntry.node, newEntry.node, newEntry.path, pageName);
            changes.push(...nodeChanges);
        }
    }

    // Find added nodes
    for (const [id, newEntry] of newMap) {
        if (!oldMap.has(id)) {
            changes.push({
                kind: 'ADDED',
                page: pageName,
                path: newEntry.path,
                property: 'node',
                newValue: newEntry.node.type,
                summary: `"${newEntry.node.name || id}" (${newEntry.node.type}) added`,
            });
        }
    }

    return changes;
}

// ─── Main diff function ───

export function diffSnapshots(oldFile: FilteredFile, newFile: FilteredFile): DesignChange[] {
    const changes: DesignChange[] = [];

    const oldPages = new Map(oldFile.pages.map(p => [p.id, p]));
    const newPages = new Map(newFile.pages.map(p => [p.id, p]));

    // Compare pages that exist in both
    for (const [pageId, newPage] of newPages) {
        const oldPage = oldPages.get(pageId);
        if (oldPage) {
            changes.push(...diffPage(oldPage, newPage));
        } else {
            changes.push({
                kind: 'ADDED',
                page: newPage.name,
                path: newPage.name,
                property: 'page',
                summary: `New page added: "${newPage.name}"`,
            });
        }
    }

    // Check for removed pages
    for (const [pageId, oldPage] of oldPages) {
        if (!newPages.has(pageId)) {
            changes.push({
                kind: 'REMOVED',
                page: oldPage.name,
                path: oldPage.name,
                property: 'page',
                summary: `Page removed: "${oldPage.name}"`,
            });
        }
    }

    return changes;
}

// ─── Format changes for LLM consumption (compact) ───

export function formatChangesForLLM(changes: DesignChange[]): string {
    if (changes.length === 0) return 'No changes detected.';

    // Group by page
    const byPage = new Map<string, DesignChange[]>();
    for (const c of changes) {
        const existing = byPage.get(c.page) || [];
        existing.push(c);
        byPage.set(c.page, existing);
    }

    const lines: string[] = [];
    for (const [page, pageChanges] of byPage) {
        lines.push(`[${page}]`);
        for (const c of pageChanges) {
            const icon = c.kind === 'ADDED' ? '+' : c.kind === 'REMOVED' ? '-' : '~';
            lines.push(`  ${icon} ${c.path}: ${c.summary}`);
        }
    }

    return lines.join('\n');
}
