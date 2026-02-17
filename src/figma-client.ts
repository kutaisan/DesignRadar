/**
 * Figma REST API Client
 * Handles file fetching and version tracking
 */

export interface FigmaFileResponse {
    name: string;
    lastModified: string;
    version: string;
    document: FigmaNode;
    components: Record<string, any>;
    styles: Record<string, any>;
}

export interface FigmaNode {
    id: string;
    name: string;
    type: string;
    visible?: boolean;
    opacity?: number;
    children?: FigmaNode[];
    fills?: any[];
    strokes?: any[];
    strokeWeight?: number;
    cornerRadius?: number;
    characters?: string;
    style?: Record<string, any>;
    fontSize?: number;
    fontFamily?: string;
    fontWeight?: number;
    textAlignHorizontal?: string;
    lineHeightPx?: number;
    letterSpacing?: number;
    absoluteBoundingBox?: { x: number; y: number; width: number; height: number };
    layoutMode?: string;
    primaryAxisAlignItems?: string;
    counterAxisAlignItems?: string;
    itemSpacing?: number;
    paddingLeft?: number;
    paddingRight?: number;
    paddingTop?: number;
    paddingBottom?: number;
    backgroundColor?: { r: number; g: number; b: number; a: number };
    componentId?: string;
    [key: string]: any;
}

export interface FigmaVersion {
    id: string;
    created_at: string;
    label: string;
    description: string;
    user: { handle: string; img_url: string };
}

export class FigmaClient {
    private token: string;
    private baseUrl = 'https://api.figma.com/v1';

    constructor(token: string) {
        this.token = token;
    }

    private async request<T>(path: string, retries = 3): Promise<T> {
        for (let i = 0; i < retries; i++) {
            const res = await fetch(`${this.baseUrl}${path}`, {
                headers: { 'X-Figma-Token': this.token },
            });

            if (res.status === 429) {
                const wait = Math.pow(2, i) * 60000;
                console.warn(`⚠️ Figma Rate Limit (429). ${wait / 1000}sn bekleniyor...`);
                await new Promise(r => setTimeout(r, wait));
                continue;
            }

            if (!res.ok) {
                const body = await res.text();
                throw new Error(`Figma API error ${res.status}: ${body}`);
            }

            return res.json() as Promise<T>;
        }
        throw new Error(`Figma API rate limit exceeded after ${retries} retries`);
    }

    async getFile(fileKey: string): Promise<FigmaFileResponse> {
        return this.request<FigmaFileResponse>(`/files/${fileKey}`);
    }

    async getFileVersions(fileKey: string): Promise<{ versions: FigmaVersion[] }> {
        return this.request(`/files/${fileKey}/versions`);
    }

    async getFileMetadata(fileKey: string): Promise<{ name: string; lastModified: string; version: string }> {
        // Depth 1 is the lightest way to get the latest 'version' and 'lastModified' 
        // that reflects ANY change in the canvas.
        const data = await this.request<any>(`/files/${fileKey}?depth=1`);

        return {
            name: data.name,
            lastModified: data.lastModified,
            version: data.version
        };
    }
}
