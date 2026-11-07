import { parentPort, workerData } from 'node:worker_threads';
import { createSessionRegistry } from './index.js';

const registry = createSessionRegistry({
  dataDir: workerData?.dataDir,
  keepFiles: workerData?.keepFiles,
  // Bad-file details may contain session identifiers; the parent only needs a safe status code.
  warn: () => {}
});

try {
  parentPort?.postMessage(registry.scanForBackgroundIndexRebuild());
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    errorCode: String(error?.code || 'sessions-index-rebuild-failed'),
    errorName: String(error?.name || 'Error')
  });
}
