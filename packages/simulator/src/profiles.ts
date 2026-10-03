import type { ToolClass } from '@claude-pet/core';

export const PROFILE_NAMES = ['idle', 'moderate', 'heavy', 'error'] as const;
export type ProfileName = (typeof PROFILE_NAMES)[number];

export type Profile = {
  name: ProfileName;
  /** Pause before the first action of a turn (the model "thinking"). */
  thinkMs: [number, number];
  /** Actions per turn. */
  actionsPerTurn: [number, number];
  /** Gap between actions within a turn. */
  gapMs: [number, number];
  /** Streaming chunks emitted at the end of a turn. */
  streamChunks: [number, number];
  /** Gap between streaming chunks. */
  streamGapMs: [number, number];
  /** Silence between turns. */
  betweenTurnsMs: [number, number];
  /** Probability an action spawns a subagent instead of running a tool. */
  subagentChance: number;
  /** Probability an action is a parallel batch of 2-4 tool calls. */
  batchChance: number;
  /** Probability an action fails. */
  errorChance: number;
  /** Probability an action needs a permission decision first. */
  permissionChance: number;
  /** Tool mix drawn for each action. */
  tools: readonly ToolClass[];
};

/**
 * Four profiles, matching the brief: idle / moderate / heavy / error.
 * The numbers are shaped to be recognisable on screen, not to model a real session
 * statistically — this is a test fixture for an animation.
 */
export const PROFILES: Record<ProfileName, Profile> = {
  idle: {
    name: 'idle',
    thinkMs: [1_500, 3_000],
    actionsPerTurn: [0, 1],
    gapMs: [2_000, 4_000],
    streamChunks: [2, 5],
    streamGapMs: [250, 600],
    betweenTurnsMs: [45_000, 90_000],
    subagentChance: 0,
    batchChance: 0,
    errorChance: 0,
    permissionChance: 0,
    tools: ['read'],
  },
  moderate: {
    name: 'moderate',
    thinkMs: [800, 2_000],
    actionsPerTurn: [4, 9],
    gapMs: [700, 2_200],
    streamChunks: [6, 16],
    streamGapMs: [120, 350],
    betweenTurnsMs: [8_000, 20_000],
    subagentChance: 0.05,
    batchChance: 0.12,
    errorChance: 0.03,
    permissionChance: 0.08,
    tools: ['read', 'search', 'edit', 'bash', 'write'],
  },
  heavy: {
    name: 'heavy',
    thinkMs: [300, 900],
    actionsPerTurn: [18, 34],
    gapMs: [90, 420],
    streamChunks: [30, 70],
    streamGapMs: [40, 110],
    betweenTurnsMs: [1_500, 4_000],
    subagentChance: 0.22,
    batchChance: 0.4,
    errorChance: 0.05,
    permissionChance: 0.02,
    tools: ['bash', 'edit', 'write', 'read', 'search', 'task', 'mcp'],
  },
  error: {
    name: 'error',
    thinkMs: [600, 1_400],
    actionsPerTurn: [3, 7],
    gapMs: [500, 1_500],
    streamChunks: [3, 8],
    streamGapMs: [150, 400],
    betweenTurnsMs: [5_000, 12_000],
    subagentChance: 0.05,
    batchChance: 0.1,
    errorChance: 0.55,
    permissionChance: 0.05,
    tools: ['bash', 'edit', 'fetch'],
  },
};
