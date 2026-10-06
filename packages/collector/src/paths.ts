import { homedir } from 'node:os';
import { join } from 'node:path';

/** Everything the pet writes lives under one 0700 directory. */
export const ROOT_DIR = process.env.CLAUDE_PET_HOME ?? join(homedir(), '.claude-pet');
export const SPOOL_DIR = join(ROOT_DIR, 'spool');
export const SPOOL_FILE = join(SPOOL_DIR, 'events.jsonl');
export const STATE_FILE = join(ROOT_DIR, 'state.json');
export const CONFIG_FILE = join(ROOT_DIR, 'config.json');
export const REFERENCE_FILE = join(ROOT_DIR, 'config.reference.jsonc');
export const TOKEN_FILE = join(ROOT_DIR, 'token');
export const LOG_DIR = join(ROOT_DIR, 'logs');
/** The standalone install: the `claude-pet` executable, the widget, the hook scripts. */
export const APP_DIR = join(ROOT_DIR, 'app');

/** Rotate at 4 MB. ~150 bytes/event, so ~28k events before a rotation. */
export const SPOOL_MAX_BYTES = 4 * 1024 * 1024;
