import { inspectPaperclip } from '../src/migration/paperclip.js';
const directory = process.argv[2];
if (!directory) { console.error('Usage: node scripts/inspect-import.mjs <paperclip-bridge-directory>'); process.exit(1); }
const result = await inspectPaperclip(directory);
console.log(JSON.stringify(result.preview, null, 2));
