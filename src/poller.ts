/**
 * Poller — Orchestrates the Figma → TOON → Diff → AI → Notify pipeline
 */

import cron from 'node-cron';
import { FigmaClient } from './figma-client.js';
import { filterFile, toToon, fromToon, type FilteredFile } from './toon-converter.js';
import { diffSnapshots, formatChangesForLLM } from './differ.js';
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

        // 2. Fetch full file
        const figmaFile = await this.figma.getFile(fileKey);
        console.log(`   📄 File: "${figmaFile.name}" (${figmaFile.document.children?.length || 0} pages)`);

        // 3. Filter & convert to TOON
        const filtered = filterFile(figmaFile);
        const toonString = toToon(filtered);
        const filteredJson = JSON.stringify(filtered);

        console.log(`   🗜️  Filtered: ${(filteredJson.length / 1024).toFixed(1)}KB JSON → ${(toonString.length / 1024).toFixed(1)}KB TOON`);

        // 4. Get previous snapshot for diff
        const prevSnapshot = this.store.getLatestSnapshot(fileKey);

        if (!prevSnapshot) {
            // First scan — save baseline, no diff possible
            console.log(`   📸 First snapshot saved (baseline)`);
            this.store.saveSnapshot(fileKey, metadata.version, figmaFile.name, toonString, filteredJson);
            this.store.updateTrackedFile(fileKey, figmaFile.name, metadata.version);
            return { hasChanges: false, changeCount: 0 };
        }

        // 5. Diff with previous
        const prevFiltered: FilteredFile = JSON.parse(prevSnapshot.filteredJson);
        const changes = diffSnapshots(prevFiltered, filtered);

        if (changes.length === 0) {
            console.log(`   ✅ Version changed but no visible design changes`);
            this.store.saveSnapshot(fileKey, metadata.version, figmaFile.name, toonString, filteredJson);
            this.store.updateTrackedFile(fileKey, figmaFile.name, metadata.version);
            return { hasChanges: false, changeCount: 0 };
        }

        console.log(`   🔄 ${changes.length} design changes detected`);

        // 6. Generate AI changelog
        console.log(`   🤖 Generating changelog...`);
        const changelog = await this.ai.generateChangelog(figmaFile.name, changes);

        // 7. Send notification
        await this.notifier.send(changelog, figmaFile.name);

        // 8. Save new snapshot
        this.store.saveSnapshot(fileKey, metadata.version, figmaFile.name, toonString, filteredJson);
        this.store.updateTrackedFile(fileKey, figmaFile.name, metadata.version);
        this.store.cleanOldSnapshots(fileKey);

        return { hasChanges: true, changeCount: changes.length };
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
