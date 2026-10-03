/**
 * The 9-state machine. Priority order is the whole design; see docs/LOAD_SCORE.md and
 * docs/MVP_SCOPE.md for how the 9 states collapse to the MVP's 4 visuals.
 */

export const PET_STATES = [
  'IDLE',
  'THINKING',
  'READING',
  'CODING',
  'TOOL_CALL',
  'HIGH_LOAD',
  'WAITING',
  'DONE',
  'ERROR',
] as const;

export type PetState = (typeof PET_STATES)[number];

/** The four visuals the MVP actually draws. */
export type VisualState = 'IDLE' | 'ACTIVE' | 'HIGH_LOAD' | 'ERROR';

export function toVisualState(state: PetState): VisualState {
  switch (state) {
    case 'IDLE':
      return 'IDLE';
    case 'ERROR':
      return 'ERROR';
    case 'HIGH_LOAD':
      return 'HIGH_LOAD';
    default:
      return 'ACTIVE';
  }
}

export type StateInputs = {
  nowMs: number;
  load: number;
  /** Last event of any kind, ms since epoch; 0 if none yet. */
  lastActivityMs: number;
  /** A turn is running: a prompt was submitted and no Stop has arrived. */
  turnActive: boolean;
  /** Claude Code is blocked on a human decision. */
  permissionPending: boolean;
  /** Last ERROR, ms since epoch; 0 if none. */
  lastErrorMs: number;
  /** Last TURN_COMPLETED, ms since epoch; 0 if none. */
  lastDoneMs: number;
  /** Last session-level sleep signal (SESSION_ENDED / MODEL_IDLE). */
  lastIdleSignalMs: number;
  /** Dominant recent activity, from the most recent activity-bearing event. */
  dominant: 'read' | 'write' | 'tool' | null;
  dominantAtMs: number;
  /** The previous resolved state, for HIGH_LOAD hysteresis. */
  previous?: PetState;
  /** Measured: a session's model is streaming right now (network sensor). */
  generating?: boolean;
};

export type StateConfig = {
  highLoadThreshold: number;
  highLoadExitThreshold?: number;
  errorStickyMs: number;
  doneStickyMs: number;
  idleAfterMs: number;
};

/**
 * Resolve the state. Ordered by what matters most to a human watching the screen:
 * a distressed or blocked session must never be hidden behind a busy animation.
 */
export function resolveState(input: StateInputs, config: StateConfig): PetState {
  const { nowMs } = input;

  // 1. Distress wins, and sticks long enough to be seen.
  if (input.lastErrorMs > 0 && nowMs - input.lastErrorMs < config.errorStickyMs) {
    return 'ERROR';
  }

  // 2. Blocked on the human. More urgent than anything Claude is doing, because the
  //    session is not progressing until the user looks.
  if (input.permissionPending) return 'WAITING';

  // 3. A completed turn, held briefly so the happy animation is not stolen by IDLE.
  if (
    input.lastDoneMs > 0 &&
    nowMs - input.lastDoneMs < config.doneStickyMs &&
    !input.turnActive
  ) {
    return 'DONE';
  }

  // 4. Genuine sleep: nothing happening and no turn running.
  const quietFor = input.lastActivityMs === 0 ? Infinity : nowMs - input.lastActivityMs;
  if (!input.turnActive && quietFor >= config.idleAfterMs) return 'IDLE';
  if (input.lastIdleSignalMs > 0 && input.lastIdleSignalMs >= input.lastActivityMs) {
    return 'IDLE';
  }

  // 5. Token storm.
  const exit = config.highLoadExitThreshold ?? config.highLoadThreshold;
  const threshold = input.previous === 'HIGH_LOAD' ? exit : config.highLoadThreshold;
  if (input.load >= threshold) return 'HIGH_LOAD';

  // 6. Measured streaming beats the last tool event: if bytes are arriving, the model is
  //    thinking or writing now, whatever tool ran before.
  if (input.generating) return 'THINKING';

  // 7. What it is visibly doing. `dominant` decays with the load window, so a long
  //    silence after a Read does not keep the creature "reading" forever.
  if (input.dominant && nowMs - input.dominantAtMs < config.idleAfterMs) {
    if (input.dominant === 'read') return 'READING';
    if (input.dominant === 'write') return 'CODING';
    return 'TOOL_CALL';
  }

  // 8. A turn is running with nothing observable in flight: the model is working.
  if (input.turnActive) return 'THINKING';

  return 'IDLE';
}
