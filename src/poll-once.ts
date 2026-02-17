/**
 * DesignRadar — Single Poll CLI
 * Run once for testing: npm run poll-once
 */

import { loadConfig } from './config.js';
import { Poller } from './poller.js';

async function main() {
    const config = loadConfig();
    const poller = new Poller(config);

    try {
        await poller.pollOnce();
    } catch (error) {
        console.error('❌ Poll failed:', error);
        process.exit(1);
    } finally {
        poller.stop();
    }
}

main();
