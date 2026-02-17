/**
 * Poller — Orchestrates the Figma → TOON → Diff → AI → Notify pipeline
 */

import cron from 'node-cron';
import { FigmaClient, type FigmaVersion } from './figma-client.js';
import { filterFile, toToon, fromToon, type FilteredFile } from './toon-converter.js';
import { diffSnapshots, formatChangesForLLM, figmaNodeLink, type DesignChange } from './differ.js';
import { AIChangelog } from './ai-changelog.js';
import { Notifier } from './mattermost.js';
import { Store } from './store.js';
import type { Config } from './config.js';

export class Poller {
    private figma: FigmaClient;
    private ai: AIChangelog;
    private notifier: Notifier;
    private store: Store;
    private config: Config;
    private cronJob?: cron.ScheduledTask;

    constructor(config: Config) {
        this.config = config;
        this.figma = new FigmaClient(config.figma.token);
        this.ai = new AIChangelog(config.llm.provider, config.llm.apiKey, config.llm.model);
        this.notifier = new Notifier(config.output);
        this.store = new Store(config.dbPath);
    }

    /**
     * Process a single file: fetch → filter → TOON → diff → changelog → notify
     */
    async processFile(fileKey: string): Promise<{ hasChanges: boolean; changeCount: number }> {
        console.log(`\n🔍 Checking file: ${fileKey}`);

        // 1. Check if file has new version
        const metadata = await this.figma.getFileMetadata(fileKey);
        const lastVersion = this.store.getLastVersion(fileKey);

        if (lastVersion === metadata.version) {
            console.log(`   ⏭️  No changes (version: ${metadata.version})`);
            return { hasChanges: false, changeCount: 0 };
        }

        console.log(`   📥 New version detected: ${lastVersion || 'first scan'} → ${metadata.version}`);

        // 2. Get version author info
        let author: { name: string; date: string } | undefined;
        try {
            const versionsData = await this.figma.getFileVersions(fileKey);
            const latestVersion = versionsData.versions[0];
            if (latestVersion) {
                author = {
                    name: latestVersion.user.handle,
                    date: new Date(latestVersion.created_at).toLocaleString('tr-TR'),
                };
            }
        } catch {
            console.warn('   ⚠️ Versiyon bilgisi alınamadı');
        }

        // 3. Fetch full file
        const figmaFile = await this.figma.getFile(fileKey);
        const rawJson = JSON.stringify(figmaFile);
        const rawSize = rawJson.length;
        const pageCount = figmaFile.document.children?.length || 0;
        console.log(`   📄 File: "${figmaFile.name}" (${pageCount} pages)`);
        if (author) {
            console.log(`   👤 Son değişiklik: ${author.name} — ${author.date}`);
        }

        // 4. Filter & convert to TOON
        const filtered = filterFile(figmaFile);
        const filteredJson = JSON.stringify(filtered);
        const toonString = toToon(filtered);
        const filteredSize = filteredJson.length;
        const toonSize = toonString.length;

        // ─── Size & Cost Analysis ───
        const filterReduction = ((rawSize - filteredSize) / rawSize * 100).toFixed(1);
        const rawTokens = Math.round(rawSize / 4);
        const filteredTokens = Math.round(filteredSize / 4);

        console.log(`\n   📊 ── Boyut & Maliyet Analizi ──`);
        console.log(`   📦 Raw Figma JSON:    ${(rawSize / 1024).toFixed(1)} KB  (~${rawTokens.toLocaleString()} token)`);
        console.log(`   🔽 Filtered JSON:     ${(filteredSize / 1024).toFixed(1)} KB  (~${filteredTokens.toLocaleString()} token)  [%${filterReduction} azalma]`);
        console.log(`   🔽 TOON Encoded:      ${(toonSize / 1024).toFixed(1)} KB`);
        console.log(`   💰 Raw → LLM:  ~$${(rawTokens * 0.0000025).toFixed(4)}  |  Filtered → LLM:  ~$${(filteredTokens * 0.0000025).toFixed(4)}`);

        // ─── Save debug logs ───
        const { mkdirSync, writeFileSync } = await import('fs');
        const logDir = `./logs/${fileKey}`;
        mkdirSync(logDir, { recursive: true });
        writeFileSync(`${logDir}/1_raw_figma.json`, rawJson);
        writeFileSync(`${logDir}/2_filtered.json`, JSON.stringify(filtered, null, 2));
        writeFileSync(`${logDir}/3_encoded.toon`, toonString);
        console.log(`   📁 Debug dosyaları: ${logDir}/`);

        // 5. Get previous snapshot for diff
        const prevSnapshot = this.store.getLatestSnapshot(fileKey);

        if (!prevSnapshot) {
            console.log(`   📸 First snapshot saved (baseline)`);
            this.store.saveSnapshot(fileKey, metadata.version, figmaFile.name, toonString, filteredJson);
            this.store.updateTrackedFile(fileKey, figmaFile.name, metadata.version);
            return { hasChanges: false, changeCount: 0 };
        }

        // 6. Diff with previous
        const prevFiltered: FilteredFile = JSON.parse(prevSnapshot.filteredJson);
        const changes = diffSnapshots(prevFiltered, filtered);

        if (changes.length === 0) {
            console.log(`   ✅ Version changed but no visible design changes`);
            this.store.saveSnapshot(fileKey, metadata.version, figmaFile.name, toonString, filteredJson);
            this.store.updateTrackedFile(fileKey, figmaFile.name, metadata.version);
            return { hasChanges: false, changeCount: 0 };
        }

        // ─── Per-page detailed log ───
        const byPage = new Map<string, DesignChange[]>();
        for (const c of changes) {
            const existing = byPage.get(c.page) || [];
            existing.push(c);
            byPage.set(c.page, existing);
        }

        console.log(`\n   🔄 ${changes.length} design change(s) across ${byPage.size} page(s):\n`);

        for (const [pageName, pageChanges] of byPage) {
            const pageId = pageChanges[0].pageId;
            const pageLink = figmaNodeLink(fileKey, pageId);
            console.log(`   📄 ${pageName} (${pageChanges.length} changes)`);
            console.log(`      🔗 ${pageLink}`);
            for (const c of pageChanges) {
                const icon = c.kind === 'ADDED' ? '➕' : c.kind === 'REMOVED' ? '➖' : '✏️';
                const nodeLink = figmaNodeLink(fileKey, c.nodeId);
                console.log(`      ${icon} ${c.path}`);
                console.log(`         ${c.summary}`);
                console.log(`         🔗 ${nodeLink}`);
            }
            console.log('');
        }

        // Save diff details
        const diffForLLM = formatChangesForLLM(changes);
        const diffTokens = Math.round(diffForLLM.length / 4);
        writeFileSync(`${logDir}/4_diff.txt`, diffForLLM);
        console.log(`   📏 LLM'e gönderilen diff: ${diffForLLM.length} char (~${diffTokens} token)`);
        console.log(`   🏆 Raw JSON yerine diff göndererek %${((rawSize - diffForLLM.length) / rawSize * 100).toFixed(1)} tasarruf!`);

        // 7. Generate AI changelog
        console.log(`\n   🤖 Generating changelog...`);
        const changelog = await this.ai.generateChangelog(figmaFile.name, changes);

        // 8. Build rich notification with author & links
        const richChangelog = this.buildRichChangelog(
            figmaFile.name, fileKey, changelog, changes, byPage, author
        );

        // 9. Send notification
        await this.notifier.send(richChangelog, figmaFile.name);

        // 10. Save new snapshot
        this.store.saveSnapshot(fileKey, metadata.version, figmaFile.name, toonString, filteredJson);
        this.store.updateTrackedFile(fileKey, figmaFile.name, metadata.version);
        this.store.cleanOldSnapshots(fileKey);

        return { hasChanges: true, changeCount: changes.length };
    }

    /**
     * Build rich changelog with author, date, per-page sections, and Figma links
     */
    private buildRichChangelog(
        fileName: string,
        fileKey: string,
        aiChangelog: string,
        changes: DesignChange[],
        byPage: Map<string, DesignChange[]>,
        author?: { name: string; date: string }
    ): string {
        const lines: string[] = [];

        // Header with author
        if (author) {
            lines.push(`👤 **${author.name}** — ${author.date}`);
        }
        lines.push(`📂 ${byPage.size} sayfa, ${changes.length} değişiklik\n`);

        // AI-generated changelog
        lines.push(aiChangelog);

        // Per-page Figma links
        lines.push(`\n🔗 **Figma Linkleri:**`);
        for (const [pageName, pageChanges] of byPage) {
            const pageLink = figmaNodeLink(fileKey, pageChanges[0].pageId);
            lines.push(`  📄 [${pageName}](${pageLink}) — ${pageChanges.length} değişiklik`);
        }

        return lines.join('\n');
    }

    /**
     * Process all tracked files once
     */
    async pollOnce(): Promise<void> {
        console.log(`\n${'─'.repeat(50)}`);
        console.log(`🕐 DesignRadar poll — ${new Date().toLocaleString('tr-TR')}`);
        console.log('─'.repeat(50));

        for (const fileKey of this.config.figma.fileKeys) {
            try {
                await this.processFile(fileKey);
            } catch (error) {
                console.error(`❌ Error processing ${fileKey}:`, error);
            }

            // Rate limiting: wait 2s between files
            if (this.config.figma.fileKeys.length > 1) {
                await new Promise(r => setTimeout(r, 2000));
            }
        }

        console.log(`\n✅ Poll complete\n`);
    }

    /**
     * Start continuous polling with cron
     */
    start(): void {
        const interval = this.config.pollIntervalMinutes;
        console.log(`🚀 DesignRadar started — polling every ${interval} minutes`);
        console.log(`📂 Tracking ${this.config.figma.fileKeys.length} file(s)`);
        console.log(`📤 Output: ${this.config.output.mode}`);
        console.log(`🤖 LLM: ${this.config.llm.provider} / ${this.config.llm.model}\n`);

        // Run immediately on start
        this.pollOnce();

        // Schedule recurring polls
        this.cronJob = cron.schedule(`*/${interval} * * * *`, () => {
            this.pollOnce();
        });
    }

    /**
     * Stop polling
     */
    stop(): void {
        this.cronJob?.stop();
        this.store.close();
        console.log('🛑 DesignRadar stopped');
    }
}
