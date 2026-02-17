/**
 * TOON Converter — Figma JSON → Filtered JSON → TOON string
 *
 * Two-phase process:
 * 1. Semantic filtering: strip irrelevant Figma properties
 * 2. TOON encoding: use @toon-format/toon SDK for token-efficient output
 */

import { encode, decode } from '@toon-format/toon';
import type { FigmaNode, FigmaFileResponse } from './figma-client.js';

// ─── Properties to KEEP (developer-relevant) ───

const KEEP_PROPERTIES = new Set([
    'id', 'name', 'type', 'visible', 'opacity',
    // Visual
    'fills', 'strokes', 'strokeWeight', 'cornerRadius',
    'backgroundColor',
    // Text
    'characters', 'fontSize', 'fontFamily', 'fontWeight',
    'textAlignHorizontal', 'lineHeightPx', 'letterSpacing',
    // Layout
    'absoluteBoundingBox',
    'layoutMode', 'primaryAxisAlignItems', 'counterAxisAlignItems',
    'itemSpacing', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom',
    // References
    'componentId',
    // Children (handled separately)
    'children',
]);

// ─── RGBA float → hex ───

function rgbaToHex(color: { r: number; g: number; b: number; a?: number }): string {
    const r = Math.round(color.r * 255);
    const g = Math.round(color.g * 255);
    const b = Math.round(color.b * 255);
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`.toUpperCase();
}

// ─── Simplify fills array ───

function simplifyFills(fills: any[]): any[] | undefined {
    if (!fills || fills.length === 0) return undefined;
    return fills
        .filter((f: any) => f.visible !== false)
        .map((f: any) => {
            const simplified: any = { type: f.type };
            if (f.color) simplified.color = rgbaToHex(f.color);
            if (f.opacity !== undefined && f.opacity !== 1) simplified.opacity = f.opacity;
            if (f.type === 'GRADIENT_LINEAR' || f.type === 'GRADIENT_RADIAL') {
                if (f.gradientStops) {
                    simplified.stops = f.gradientStops.map((s: any) => ({
                        color: rgbaToHex(s.color),
                        pos: s.position,
                    }));
                }
            }
            if (f.type === 'IMAGE') {
                simplified.imageRef = f.imageRef;
                simplified.scaleMode = f.scaleMode;
            }
            return simplified;
        });
}

// ─── Simplify bounding box ───

function simplifyBoundingBox(bb: { x: number; y: number; width: number; height: number }) {
    return { x: Math.round(bb.x), y: Math.round(bb.y), w: Math.round(bb.width), h: Math.round(bb.height) };
}

// ─── Filter a single Figma node recursively ───

export function filterNode(node: FigmaNode): Record<string, any> {
    const filtered: Record<string, any> = {};

    for (const key of KEEP_PROPERTIES) {
        if (key === 'children') continue; // handled below
        if (!(key in node)) continue;

        const val = node[key];

        // Skip defaults that don't need to be stored
        if (key === 'visible' && val === true) continue;
        if (key === 'opacity' && val === 1) continue;

        // Special transformations
        if (key === 'fills') {
            const simplified = simplifyFills(val);
            if (simplified && simplified.length > 0) filtered.fills = simplified;
            continue;
        }
        if (key === 'strokes') {
            const simplified = simplifyFills(val); // same structure
            if (simplified && simplified.length > 0) filtered.strokes = simplified;
            continue;
        }
        if (key === 'backgroundColor' && val) {
            filtered.backgroundColor = rgbaToHex(val);
            continue;
        }
        if (key === 'absoluteBoundingBox' && val) {
            filtered.bounds = simplifyBoundingBox(val);
            continue;
        }

        // Skip zero/empty values
        if (key === 'strokeWeight' && val === 0) continue;
        if (key === 'cornerRadius' && val === 0) continue;
        if (key === 'itemSpacing' && val === 0) continue;
        if (key === 'paddingLeft' && val === 0) continue;
        if (key === 'paddingRight' && val === 0) continue;
        if (key === 'paddingTop' && val === 0) continue;
        if (key === 'paddingBottom' && val === 0) continue;
        if (key === 'layoutMode' && val === 'NONE') continue;

        filtered[key] = val;
    }

    // Recursively filter children
    if (node.children && node.children.length > 0) {
        filtered.children = node.children.map(child => filterNode(child));
    }

    return filtered;
}

// ─── Convert full Figma file to filtered structure ───

export interface FilteredPage {
    id: string;
    name: string;
    children: Record<string, any>[];
}

export interface FilteredFile {
    name: string;
    version: string;
    lastModified: string;
    pages: FilteredPage[];
}

export function filterFile(figmaResponse: FigmaFileResponse): FilteredFile {
    const doc = figmaResponse.document;
    // Document > Canvas (pages) > children
    const pages: FilteredPage[] = (doc.children || []).map(page => ({
        id: page.id,
        name: page.name,
        children: (page.children || []).map(child => filterNode(child)),
    }));

    return {
        name: figmaResponse.name,
        version: figmaResponse.version,
        lastModified: figmaResponse.lastModified,
        pages,
    };
}

// ─── Encode filtered file to TOON string ───

export function toToon(filteredFile: FilteredFile): string {
    return encode(filteredFile);
}

// ─── Decode TOON string back to object ───

export function fromToon(toonString: string): FilteredFile {
    return decode(toonString) as FilteredFile;
}

// ─── Full pipeline: Figma response → TOON string ───

export function figmaToToon(figmaResponse: FigmaFileResponse): string {
    const filtered = filterFile(figmaResponse);
    return toToon(filtered);
}
