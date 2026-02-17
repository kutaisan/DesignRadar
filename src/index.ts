/**
 * DesignRadar — Entry Point
 * Continuous polling mode
 */

import { loadConfig } from './config.js';
import { Poller } from './poller.js';

const config = loadConfig();
const poller = new Poller(config);

// Graceful shutdown
process.on('SIGINT', () => {
    poller.stop();
    process.exit(0);
});
process.on('SIGTERM', () => {
    poller.stop();
    process.exit(0);
});

poller.start();
