import { Schema, type } from "@colyseus/schema";

export class Player extends Schema {
  @type("string") sessionId = "";
  @type("string") name = "";
  @type("boolean") isHost = false;
  @type("boolean") ready = false;
  @type("number") teamId = -1;

  @type("boolean") isRunner = false;

  @type("number") row = 0;
  @type("number") col = 0;
  @type("boolean") hasBone = false;

  // Match results tracking.
  // bonesScored counts successful bone returns.
  // pointsScored includes score multipliers such as x2 points.
  @type("number") bonesScored = 0;
  @type("number") pointsScored = 0;

  // Held power state.
  // Empty string means this player currently has no held power.
  // Spectators use this with spectatorSlotTeamId/spectatorSlotIndex.
  // Runners use this with hasBoardPower when they collect a board debuff.
  // Valid values:
  // "shield", "speed", "double_points", "invisible",
  // "freeze", "glue", "reverse", "drop_bone".
  @type("string") activePower = "";

  // True when a runner is carrying a debuff picked up from the maze board.
  // This keeps board pickups separate from spectator power slots.
  @type("boolean") hasBoardPower = false;

  // Which spectator square this player is occupying.
  // teamId is 0 Red, 1 Blue, 2 Green, 3 Yellow.
  // slotIndex is 0 or 1.
  @type("number") spectatorSlotTeamId = -1;
  @type("number") spectatorSlotIndex = -1;

  // Server timestamp when the spectator power expires.
  @type("number") powerExpiresAt = 0;

  // Runner buff state.
  @type("boolean") isShielded = false;
  @type("boolean") isSpeedBoosted = false;
  @type("boolean") hasDoublePoints = false;
  @type("boolean") isInvisible = false;

  @type("number") shieldExpiresAt = 0;
  @type("number") speedBoostExpiresAt = 0;
  @type("number") invisibleExpiresAt = 0;

  // Runner debuff state.
  @type("boolean") isFrozen = false;
  @type("boolean") isGlued = false;
  @type("boolean") isControlsReversed = false;

  @type("number") frozenExpiresAt = 0;
  @type("number") gluedExpiresAt = 0;
  @type("number") controlsReversedExpiresAt = 0;

  // Used by Glue. Odd attempts are blocked, even attempts move.
  @type("number") glueMoveAttemptCount = 0;
}
