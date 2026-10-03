import { homedir } from 'node:os';
import { join } from 'node:path';

/** Everything the pet writes lives under one 0700 directory. */
export const ROOT_DIR = process.env.CLAUDE_PET_HOME ?? join(homedir(), '.claude-pet');
export const SPOOL_DIR = join(ROOT_DIR, 'spool');
export const SPOOL_FILE = join(SPOOL_DIR, 'events.jsonl');
export const STATE_FILE = join(ROOT_DIR, 'state.json');
export const CONFIG_FILE = join(ROOT_DIR, 'config.json');

/** Rotate at 4 MB. ~150 bytes/event, so ~28k events before a rotation. */
export const SPOOL_MAX_BYTES = 4 * 1024 * 1024;
