import { describe, it, expect } from 'vitest';
import { diffSnapshots, formatChangesForLLM, type DesignChange } from '../src/differ.js';
import { filterFile, type FilteredFile } from '../src/toon-converter.js';
import figmaSample from './fixtures/figma-sample.json';

// Helper: create a deep clone and modify specific values
function cloneAndModify(obj: any, modifications: (clone: any) => void): any {
    const clone = JSON.parse(JSON.stringify(obj));
    modifications(clone);
    return clone;
}

describe('TOON Differ', () => {
    const baseFiltered = filterFile(figmaSample as any);

    describe('diffSnapshots', () => {
        it('should detect no changes for identical files', () => {
            const changes = diffSnapshots(baseFiltered, baseFiltered);
            expect(changes).toHaveLength(0);
        });

        it('should detect color changes', () => {
            const modified = cloneAndModify(baseFiltered, (f) => {
                // Change Login Button fill color from blue to red
                const header = f.pages[0].children[0]; // Header
                const loginBtn = header.children[1]; // Login Button
                loginBtn.fills[0].color = '#FF0000';
            });

            const changes = diffSnapshots(baseFiltered, modified);
            expect(changes.length).toBeGreaterThan(0);

            const fillChange = changes.find(c => c.property === 'fills');
            expect(fillChange).toBeDefined();
            expect(fillChange!.kind).toBe('MODIFIED');
            expect(fillChange!.path).toContain('Login Button');
        });

        it('should detect text changes', () => {
            const modified = cloneAndModify(baseFiltered, (f) => {
                const hero = f.pages[0].children[1]; // Hero Section
                const title = hero.children[0]; // Hero Title
                title.characters = 'Yeni Başlık';
            });

            const changes = diffSnapshots(baseFiltered, modified);
            const textChange = changes.find(c => c.property === 'characters');
            expect(textChange).toBeDefined();
            expect(textChange!.kind).toBe('MODIFIED');
            expect(textChange!.summary).toContain('Yeni Başlık');
        });

        it('should detect added nodes', () => {
            const modified = cloneAndModify(baseFiltered, (f) => {
                const header = f.pages[0].children[0];
                header.children.push({
                    id: '9:9',
                    name: 'New Badge',
                    type: 'FRAME',
                    fills: [{ type: 'SOLID', color: '#00FF00' }],
                });
            });

            const changes = diffSnapshots(baseFiltered, modified);
            const addedNode = changes.find(c => c.kind === 'ADDED' && c.property === 'node');
            expect(addedNode).toBeDefined();
            expect(addedNode!.summary).toContain('New Badge');
        });

        it('should detect removed nodes', () => {
            const modified = cloneAndModify(baseFiltered, (f) => {
                const hero = f.pages[0].children[1]; // Hero Section
                hero.children.pop(); // Remove CTA Button
            });

            const changes = diffSnapshots(baseFiltered, modified);
            const removedNode = changes.find(c => c.kind === 'REMOVED' && c.property === 'node');
            expect(removedNode).toBeDefined();
            expect(removedNode!.summary).toContain('CTA Button');
        });

        it('should detect size/position changes', () => {
            const modified = cloneAndModify(baseFiltered, (f) => {
                const header = f.pages[0].children[0];
                header.bounds = { x: 0, y: 0, w: 1200, h: 100 }; // Changed from 1440x80
            });

            const changes = diffSnapshots(baseFiltered, modified);
            const boundsChange = changes.find(c => c.property === 'bounds');
            expect(boundsChange).toBeDefined();
            expect(boundsChange!.kind).toBe('MODIFIED');
        });

        it('should detect name changes', () => {
            const modified = cloneAndModify(baseFiltered, (f) => {
                const header = f.pages[0].children[0];
                header.children[1].name = 'Sign In Button'; // Was "Login Button"
            });

            const changes = diffSnapshots(baseFiltered, modified);
            const nameChange = changes.find(c => c.property === 'name');
            expect(nameChange).toBeDefined();
            expect(nameChange!.summary).toContain('Login Button');
            expect(nameChange!.summary).toContain('Sign In Button');
        });

        it('should detect page additions', () => {
            const modified = cloneAndModify(baseFiltered, (f) => {
                f.pages.push({
                    id: '0:99',
                    name: 'Settings Page',
                    children: [],
                });
            });

            const changes = diffSnapshots(baseFiltered, modified);
            const pageAdded = changes.find(c => c.property === 'page' && c.kind === 'ADDED');
            expect(pageAdded).toBeDefined();
            expect(pageAdded!.summary).toContain('Settings Page');
        });
    });

    describe('formatChangesForLLM', () => {
        it('should format changes in compact text', () => {
            const changes: DesignChange[] = [
                {
                    kind: 'MODIFIED',
                    page: 'Home Page',
                    path: 'Header / Login Button',
                    property: 'fills',
                    oldValue: [{ color: '#3366E6' }],
                    newValue: [{ color: '#FF0000' }],
                    summary: 'fills: #3366E6 → #FF0000',
                },
                {
                    kind: 'ADDED',
                    page: 'Home Page',
                    path: 'Header / New Badge',
                    property: 'node',
                    newValue: 'FRAME',
                    summary: '"New Badge" (FRAME) added',
                },
            ];

            const formatted = formatChangesForLLM(changes);
            expect(formatted).toContain('[Home Page]');
            expect(formatted).toContain('~');
            expect(formatted).toContain('+');
            expect(formatted).toContain('Login Button');
            expect(formatted).toContain('New Badge');
        });

        it('should return message for empty changes', () => {
            const formatted = formatChangesForLLM([]);
            expect(formatted).toBe('No changes detected.');
        });
    });
});
