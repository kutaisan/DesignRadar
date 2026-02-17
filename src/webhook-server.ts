/**
 * Figma Webhook Server
 * Receives FILE_UPDATE events from Figma and triggers the diff pipeline
 * 
 * Flow:
 *   1. Start HTTP server on a port
 *   2. Expose via ngrok (or any tunnel)
 *   3. Register webhook with Figma API
 *   4. Receive FILE_UPDATE → trigger processFile()
 */

import http from 'node:http';
import { FigmaClient } from './figma-client.js';
import { filterFile, toToon, type FilteredFile } from './toon-converter.js';
import { diffSnapshots, formatChangesForLLM, figmaNodeLink, type DesignChange } from './differ.js';
import { AIChangelog } from './ai-changelog.js';
import { Notifier } from './mattermost.js';
import { Store } from './store.js';
import type { Config } from './config.js';

interface FigmaWebhookPayload {
    event_type: string;
    passcode: string;
    timestamp: string;
    webhook_id: string;
    file_key?: string;
    file_name?: string;
    triggered_by?: { id: string; handle: string };
}

export class WebhookServer {
    private figma: FigmaClient;
    private ai: AIChangelog;
    private notifier: Notifier;
    private store: Store;
    private config: Config;
    private server: http.Server | null = null;
    private passcode: string;
    private webhookIds: string[] = [];
    private processing = new Set<string>(); // prevent duplicate processing

    constructor(config: Config) {
        this.config = config;
        this.figma = new FigmaClient(config.figma.token);
        this.ai = new AIChangelog(config.llm.provider, config.llm.apiKey, config.llm.model);
        this.notifier = new Notifier(config.output);
        this.store = new Store(config.dbPath);
        this.passcode = config.webhookPasscode || `dr_${Date.now()}`;
    }

    /**
     * Process a file change triggered by webhook
     */
    async processFile(fileKey: string, triggeredBy?: string): Promise<void> {
        // Prevent duplicate processing of same file
        if (this.processing.has(fileKey)) {
            console.log(`   ⏭️  ${fileKey} zaten işleniyor, atlanıyor`);
            return;
        }
        this.processing.add(fileKey);

        try {
            console.log(`\n🔍 Webhook tetiklendi: ${fileKey}`);
            if (triggeredBy) {
                console.log(`   👤 Değişikliği yapan: ${triggeredBy}`);
            }

            // Small delay to let Figma settle (changes may still be saving)
            await new Promise(r => setTimeout(r, 3000));

            // 1. Fetch full file
            const figmaFile = await this.figma.getFile(fileKey);
            const rawJson = JSON.stringify(figmaFile);
            const rawSize = rawJson.length;
            const pageCount = figmaFile.document.children?.length || 0;
            console.log(`   📄 File: "${figmaFile.name}" (${pageCount} pages)`);

            // 2. Filter & convert to TOON
            const filtered = filterFile(figmaFile);
            const filteredJson = JSON.stringify(filtered);
            const toonString = toToon(filtered);

            // ─── Size Analysis ───
            const filteredSize = filteredJson.length;
            const filterReduction = ((rawSize - filteredSize) / rawSize * 100).toFixed(1);
            console.log(`   📊 Raw: ${(rawSize / 1024).toFixed(1)}KB → Filtered: ${(filteredSize / 1024).toFixed(1)}KB [%${filterReduction} azalma]`);

            // ─── Save debug logs ───
            const { mkdirSync, writeFileSync } = await import('fs');
            const logDir = `./logs/${fileKey}`;
            mkdirSync(logDir, { recursive: true });
            writeFileSync(`${logDir}/1_raw_figma.json`, rawJson);
            writeFileSync(`${logDir}/2_filtered.json`, JSON.stringify(filtered, null, 2));
            writeFileSync(`${logDir}/3_encoded.toon`, toonString);

            // 3. Get previous snapshot
            const prevSnapshot = this.store.getLatestSnapshot(fileKey);
            const version = Date.now().toString();

            if (!prevSnapshot) {
                console.log(`   📸 İlk snapshot kaydedildi (baseline)`);
                this.store.saveSnapshot(fileKey, version, figmaFile.name, toonString, filteredJson);
                this.store.updateTrackedFile(fileKey, figmaFile.name, version);
                return;
            }

            // 4. Diff
            const prevFiltered: FilteredFile = JSON.parse(prevSnapshot.filteredJson);
            const changes = diffSnapshots(prevFiltered, filtered);

            if (changes.length === 0) {
                console.log(`   ✅ Görsel değişiklik yok (metadata değişmiş olabilir)`);
                this.store.saveSnapshot(fileKey, version, figmaFile.name, toonString, filteredJson);
                return;
            }

            // ─── Per-page grouped output ───
            const byPage = new Map<string, DesignChange[]>();
            for (const c of changes) {
                const existing = byPage.get(c.page) || [];
                existing.push(c);
                byPage.set(c.page, existing);
            }

            console.log(`\n   🔄 ${changes.length} değişiklik, ${byPage.size} sayfada:\n`);

            for (const [pageName, pageChanges] of byPage) {
                const pageLink = figmaNodeLink(fileKey, pageChanges[0].pageId);
                console.log(`   📄 ${pageName} (${pageChanges.length} değişiklik)`);
                console.log(`      🔗 ${pageLink}`);
                for (const c of pageChanges) {
                    const icon = c.kind === 'ADDED' ? '➕' : c.kind === 'REMOVED' ? '➖' : '✏️';
                    console.log(`      ${icon} ${c.path} → ${c.summary}`);
                }
                console.log('');
            }

            // Save diff
            const diffForLLM = formatChangesForLLM(changes);
            writeFileSync(`${logDir}/4_diff.txt`, diffForLLM);

            // 5. Generate AI changelog
            console.log(`   🤖 Changelog oluşturuluyor...`);
            const changelog = await this.ai.generateChangelog(figmaFile.name, changes);

            // 6. Build rich notification
            const lines: string[] = [];
            if (triggeredBy) {
                lines.push(`👤 **${triggeredBy}** — ${new Date().toLocaleString('tr-TR')}`);
            }
            lines.push(`📂 ${byPage.size} sayfa, ${changes.length} değişiklik\n`);
            lines.push(changelog);
            lines.push(`\n🔗 **Figma Linkleri:**`);
            for (const [pageName, pageChanges] of byPage) {
                const pageLink = figmaNodeLink(fileKey, pageChanges[0].pageId);
                lines.push(`  📄 [${pageName}](${pageLink}) — ${pageChanges.length} değişiklik`);
            }

            await this.notifier.send(lines.join('\n'), figmaFile.name);

            // 7. Save snapshot
            this.store.saveSnapshot(fileKey, version, figmaFile.name, toonString, filteredJson);
            this.store.updateTrackedFile(fileKey, figmaFile.name, version);
            this.store.cleanOldSnapshots(fileKey);

        } finally {
            this.processing.delete(fileKey);
        }
    }

    /**
     * Register webhook with Figma for a team
     */
    async registerWebhook(teamId: string, publicUrl: string): Promise<string> {
        const endpoint = `${publicUrl}/webhook`;
        console.log(`\n📝 Webhook kaydediliyor...`);
        console.log(`   Team: ${teamId}`);
        console.log(`   Endpoint: ${endpoint}`);
        console.log(`   Passcode: ${this.passcode}`);

        const res = await fetch('https://api.figma.com/v2/webhooks', {
            method: 'POST',
            headers: {
                'X-Figma-Token': this.config.figma.token,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                event_type: 'FILE_UPDATE',
                team_id: teamId,
                endpoint,
                passcode: this.passcode,
                description: 'DesignRadar — Design Change Tracker',
            }),
        });

        if (!res.ok) {
            const body = await res.text();
            throw new Error(`Webhook kayıt hatası ${res.status}: ${body}`);
        }

        const data = await res.json() as any;
        const webhookId = data.id;
        this.webhookIds.push(webhookId);
        console.log(`   ✅ Webhook kaydedildi! ID: ${webhookId}`);
        return webhookId;
    }

    /**
     * List existing webhooks for a team
     */
    async listWebhooks(teamId: string): Promise<any[]> {
        const res = await fetch(`https://api.figma.com/v2/teams/${teamId}/webhooks`, {
            headers: { 'X-Figma-Token': this.config.figma.token },
        });

        if (!res.ok) {
            const body = await res.text();
            throw new Error(`Webhook listesi alınamadı ${res.status}: ${body}`);
        }

        const data = await res.json() as any;
        return data.webhooks || [];
    }

    /**
     * Delete a webhook
     */
    async deleteWebhook(webhookId: string): Promise<void> {
        const res = await fetch(`https://api.figma.com/v2/webhooks/${webhookId}`, {
            method: 'DELETE',
            headers: { 'X-Figma-Token': this.config.figma.token },
        });

        if (res.ok) {
            console.log(`   🗑️  Webhook silindi: ${webhookId}`);
        }
    }

    /**
     * Start the webhook HTTP server
     */
    start(port: number = 3100): Promise<void> {
        return new Promise((resolve) => {
            this.server = http.createServer(async (req, res) => {
                // Health check
                if (req.method === 'GET' && req.url === '/health') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'ok', mode: 'webhook' }));
                    return;
                }

                // Webhook endpoint
                if (req.method === 'POST' && req.url === '/webhook') {
                    let body = '';
                    req.on('data', chunk => { body += chunk; });
                    req.on('end', async () => {
                        // Respond immediately (Figma expects fast response)
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ status: 'received' }));

                        try {
                            const payload: FigmaWebhookPayload = JSON.parse(body);

                            // Verify passcode
                            if (payload.passcode !== this.passcode) {
                                console.warn(`⚠️ Geçersiz passcode, webhook reddedildi`);
                                return;
                            }

                            console.log(`\n${'─'.repeat(50)}`);
                            console.log(`🔔 Webhook alındı — ${new Date().toLocaleString('tr-TR')}`);
                            console.log(`   Event: ${payload.event_type}`);
                            console.log(`   File: ${payload.file_name || payload.file_key}`);
                            if (payload.triggered_by) {
                                console.log(`   By: ${payload.triggered_by.handle}`);
                            }
                            console.log('─'.repeat(50));

                            if (payload.event_type === 'FILE_UPDATE' && payload.file_key) {
                                // Check if this file is one we're tracking
                                const isTracked = this.config.figma.fileKeys.includes(payload.file_key);
                                if (!isTracked) {
                                    console.log(`   ⏭️  ${payload.file_key} takip listesinde değil, atlanıyor`);
                                    return;
                                }

                                await this.processFile(
                                    payload.file_key,
                                    payload.triggered_by?.handle
                                );
                            }
                        } catch (err) {
                            console.error('❌ Webhook işleme hatası:', err);
                        }
                    });
                    return;
                }

                // 404 for everything else
                res.writeHead(404);
                res.end('Not Found');
            });

            this.server.listen(port, () => {
                console.log(`\n🚀 DesignRadar Webhook Server başlatıldı`);
                console.log(`   📡 Port: ${port}`);
                console.log(`   🔑 Passcode: ${this.passcode}`);
                console.log(`   📂 Tracking: ${this.config.figma.fileKeys.length} file(s)`);
                console.log(`   🤖 LLM: ${this.config.llm.provider} / ${this.config.llm.model}`);
                console.log(`\n   ⏳ Figma webhook olayları bekleniyor...\n`);
                resolve();
            });
        });
    }

    /**
     * Stop the server and cleanup webhooks
     */
    async stop(): Promise<void> {
        // Cleanup registered webhooks
        for (const id of this.webhookIds) {
            try {
                await this.deleteWebhook(id);
            } catch { }
        }

        if (this.server) {
            this.server.close();
        }
        this.store.close();
        console.log('\n🛑 DesignRadar Webhook Server durduruldu');
    }
}
