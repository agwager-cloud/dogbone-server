import { Room, Client } from "colyseus";
import { LobbyState, BoardPowerItem } from "./schema/LobbyState";
import { Player } from "./schema/Player";

type CellPoint = {
  row: number;
  col: number;
};

type MoveDogMessage = {
  rowChange?: number;
  colChange?: number;
  distance?: number;
};

type PowerType =
  | "shield"
  | "speed"
  | "double_points"
  | "invisible"
  | "freeze"
  | "glue"
  | "reverse"
  | "drop_bone";

type CastPowerMessage = {
  targetSessionId?: string;
};

type SetTargetScoreMessage = {
  targetScore?: number;
};

type NewGameMessage = {
  targetScore?: number;
};

type SetPlayerTeamMessage = {
  sessionId?: string;
  teamId?: number;
};

type RemovePlayerMessage = {
  sessionId?: string;
};

const ROUND_SECONDS = 60;
const ROUND_END_DELAY_MS = 1500;

const DEFAULT_TARGET_SCORE = 5;
const MIN_TARGET_SCORE = 1;
const MAX_TARGET_SCORE = 25;

const POWER_SPAWN_MIN_MS = 4000;
const POWER_SPAWN_MAX_MS = 8000;
const POWER_EXPIRE_MS = 10000;

const BOARD_DEBUFF_SPAWN_MIN_MS = 4000;
const BOARD_DEBUFF_SPAWN_MAX_MS = 8000;
const MAX_ACTIVE_BOARD_DEBUFF_ITEMS = 3;

const SHIELD_MS = 5000;
const SPEED_BOOST_MS = 5000;
const INVISIBLE_MS = 5000;
const FREEZE_MS = 5000;
const GLUE_MS = 5000;
const REVERSE_CONTROLS_MS = 5000;

const MAX_ACTIVE_SPECTATOR_POWERS = 2;
const SPECTATOR_SLOTS_PER_TEAM = 2;

// Weighted power pool. Drop Bone is deliberately rare.
const POWER_WEIGHTS: { type: PowerType; weight: number }[] = [
  { type: "shield", weight: 18 },
  { type: "speed", weight: 16 },
  { type: "double_points", weight: 12 },
  { type: "invisible", weight: 12 },
  { type: "freeze", weight: 16 },
  { type: "glue", weight: 11 },
  { type: "reverse", weight: 11 },
  { type: "drop_bone", weight: 4 },
];

// Board pickups only use debuffs. Drop Bone stays rare.
const BOARD_DEBUFF_WEIGHTS: { type: PowerType; weight: number }[] = [
  { type: "freeze", weight: 32 },
  { type: "glue", weight: 30 },
  { type: "reverse", weight: 30 },
  { type: "drop_bone", weight: 8 },
];

const MAX_PLAYER_NAME_LENGTH = 8;

const MAZE_ROWS = 11;
const MAZE_COLS = 11;

export class DogBoneRoom extends Room<LobbyState> {
  maxClients = 40;

  private roundTimer?: any;

  private spectatorSpawnTimer?: any;
  private boardDebuffSpawnTimer?: any;
  private boardDebuffItemCounter = 0;
  private powerExpireTimers = new Map<string, any>();
  private effectExpireTimers = new Map<string, any>();

  private static usedJoinCodes = new Set<string>();
  public static joinCodeToRoomId = new Map<string, string>();

  private static generateJoinCode(): string {
    let code = "";

    do {
      code = Math.floor(10000 + Math.random() * 90000).toString();
    } while (DogBoneRoom.usedJoinCodes.has(code));

    DogBoneRoom.usedJoinCodes.add(code);
    return code;
  }

  private normalizePlayerName(value: unknown, fallback: string) {
    const rawName = typeof value === "string" ? value : "";
    const cleanName = rawName.replace(/\s+/g, " ").trim();
    const limitedName = Array.from(cleanName)
      .slice(0, MAX_PLAYER_NAME_LENGTH)
      .join("")
      .trim();

    if (limitedName.length > 0) {
      return limitedName;
    }

    return Array.from(fallback)
      .slice(0, MAX_PLAYER_NAME_LENGTH)
      .join("")
      .trim();
  }

  private getRandomBalancedTeamId(): number {
    const teamCounts = [0, 0, 0, 0];

    for (const player of this.state.players.values()) {
      if (player.teamId >= 0 && player.teamId < teamCounts.length) {
        teamCounts[player.teamId] += 1;
      }
    }

    const lowestCount = Math.min(...teamCounts);
    const availableTeamIds = teamCounts.flatMap((count, teamId) =>
      count === lowestCount ? [teamId] : [],
    );

    return (
      availableTeamIds[Math.floor(Math.random() * availableTeamIds.length)] ?? 0
    );
  }

  onCreate(options: any) {
    console.log("DogBoneRoom created:", this.roomId);

    // Send state patches more frequently so touch movement feels more responsive.
    // This keeps the server authoritative but reduces the wait for clients to
    // receive the updated runner position after a move_dog message.
    this.setPatchRate(20);

    this.setState(new LobbyState());

    const joinCode = DogBoneRoom.generateJoinCode();

    this.state.joinCode = joinCode;
    this.state.roundPhase = "lobby";
    this.state.roundNumber = 0;
    this.state.remainingSeconds = ROUND_SECONDS;
    this.state.roundMessage = "Waiting for the host to start the game.";
    this.state.targetScore = DEFAULT_TARGET_SCORE;
    this.state.matchEnded = false;
    this.state.winningTeamId = -1;

    DogBoneRoom.joinCodeToRoomId.set(joinCode, this.roomId);

    this.onMessage("set_ready", (client, message: { ready: boolean }) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;

      player.ready = !!message?.ready;
    });

    this.onMessage("start_game", (client, message: SetTargetScoreMessage) => {
      if (client.sessionId !== this.state.hostId) {
        console.log(`Non-host tried to start game: ${client.sessionId}`);
        return;
      }

      this.setTargetScoreFromMessage(message);

      if (!this.state.gameStarted || this.state.matchEnded) {
        this.startNewMatch();
      }

      console.log(
        `Host started game in room ${this.roomId} (joinCode ${this.state.joinCode}, target ${this.state.targetScore})`,
      );

      this.broadcast("start_game");
    });

    this.onMessage("move_dog", (client, message: MoveDogMessage) => {
      this.handleMoveDog(client, message);
    });

    this.onMessage("cast_power", (client, message: CastPowerMessage) => {
      this.handleCastPower(client, message);
    });

    this.onMessage(
      "set_target_score",
      (client, message: SetTargetScoreMessage) => {
        if (client.sessionId !== this.state.hostId) return;

        this.setTargetScoreFromMessage(message);
      },
    );

    this.onMessage("new_game", (client, message: NewGameMessage) => {
      if (client.sessionId !== this.state.hostId) return;

      this.setTargetScoreFromMessage(message);
      this.startNewMatch();
      this.broadcast("start_game");
    });

    this.onMessage("return_to_lobby", (client) => {
      if (client.sessionId !== this.state.hostId) return;

      this.returnToLobby();
      this.broadcast("return_to_lobby");
    });

    this.onMessage(
      "set_player_team",
      (client, message: SetPlayerTeamMessage) => {
        this.handleSetPlayerTeam(client, message);
      },
    );

    this.onMessage("remove_player", (client, message: RemovePlayerMessage) => {
      this.handleRemovePlayer(client, message);
    });
  }

  onJoin(client: Client, options: any) {
    console.log(`Client joined: ${client.sessionId}`, options);

    const player = new Player();

    player.sessionId = client.sessionId;
    player.name = this.normalizePlayerName(
      options?.name,
      `Player ${this.clients.length}`,
    );

    player.ready = false;
    player.teamId = this.getRandomBalancedTeamId();

    if (!this.state.hostId) {
      this.state.hostId = client.sessionId;
      player.isHost = true;
    } else {
      player.isHost = false;
    }

    // Late joiners should not become runners mid-round.
    // They join the team list now and can be selected from the next round onward.
    player.isRunner = false;
    player.hasBone = false;
    this.placePlayerAtTeamStart(player);

    this.state.players.set(client.sessionId, player);

    console.log(
      `Player added: ${player.name} (${client.sessionId}) host=${player.isHost} team=${player.teamId} runner=${player.isRunner} row=${player.row} col=${player.col}`,
    );

    if (this.state.matchEnded) {
      client.send("match_end");
    } else if (this.state.gameStarted) {
      client.send("start_game");
    }
  }

  onLeave(client: Client, consented: boolean) {
    console.log(`Client left: ${client.sessionId} consented=${consented}`);

    const wasHost = this.state.hostId === client.sessionId;
    const wasBoneCarrier = this.state.boneCarrierSessionId === client.sessionId;

    this.state.players.delete(client.sessionId);

    this.clearPowerExpireTimer(client.sessionId);
    this.clearEffectTimers(client.sessionId);

    if (this.state.gameStarted && this.state.roundPhase === "playing") {
      this.scheduleNextPowerSpawn(true);
    }

    if (wasBoneCarrier && this.state.roundPhase === "playing") {
      this.state.boneCarrierSessionId = "";
      this.stopBoardDebuffSpawner();
      this.clearAllBoardDebuffItems();
      this.state.roundMessage =
        "The bone carrier disconnected. The bone is back in the centre.";
    }

    if (wasHost) {
      let newHostId = "";

      for (const [sessionId, player] of this.state.players.entries()) {
        newHostId = sessionId;
        player.isHost = true;
        break;
      }

      this.state.hostId = newHostId;

      for (const [sessionId, player] of this.state.players.entries()) {
        if (sessionId !== newHostId) {
          player.isHost = false;
        }
      }

      if (newHostId) {
        console.log(`New host assigned: ${newHostId}`);
      } else {
        console.log(`No players left in room ${this.roomId}`);
      }
    }
  }

  private isHostClient(client: Client) {
    return client.sessionId === this.state.hostId;
  }

  private canHostEditLobby(client: Client) {
    return (
      this.isHostClient(client) &&
      !this.state.gameStarted &&
      !this.state.matchEnded &&
      this.state.roundPhase === "lobby"
    );
  }

  private handleSetPlayerTeam(client: Client, message: SetPlayerTeamMessage) {
    if (!this.canHostEditLobby(client)) return;

    const targetSessionId =
      typeof message?.sessionId === "string" ? message.sessionId : "";
    const targetTeamId = Number(message?.teamId ?? -1);

    if (!targetSessionId) return;
    if (!Number.isInteger(targetTeamId)) return;
    if (targetTeamId < 0 || targetTeamId > 3) return;

    const target = this.state.players.get(targetSessionId);
    if (!target) return;

    target.teamId = targetTeamId;
    target.isRunner = false;
    target.hasBone = false;
    target.activePower = "";
    target.hasBoardPower = false;
    target.spectatorSlotTeamId = -1;
    target.spectatorSlotIndex = -1;
    target.powerExpiresAt = 0;

    this.clearPowerExpireTimer(target.sessionId);
    this.clearEffectTimers(target.sessionId);
    this.clearPlayerRunnerEffects(target);
    this.placePlayerAtTeamStart(target);

    console.log(
      `Host moved ${target.name} (${target.sessionId}) to ${this.getTeamName(targetTeamId)} Team`,
    );
  }

  private handleRemovePlayer(client: Client, message: RemovePlayerMessage) {
    if (!this.canHostEditLobby(client)) return;

    const targetSessionId =
      typeof message?.sessionId === "string" ? message.sessionId : "";

    if (!targetSessionId) return;
    if (targetSessionId === this.state.hostId) return;

    const target = this.state.players.get(targetSessionId);
    if (!target) return;

    this.clearPowerExpireTimer(targetSessionId);
    this.clearEffectTimers(targetSessionId);

    if (this.state.boneCarrierSessionId === targetSessionId) {
      this.state.boneCarrierSessionId = "";
    }

    this.state.players.delete(targetSessionId);

    const targetClient = this.clients.find(
      (roomClient) => roomClient.sessionId === targetSessionId,
    );

    targetClient?.send("removed_from_room", {
      reason: "Removed by the host.",
    });

    // Tell the client first, then close their socket if the Colyseus version
    // exposes a server-side leave method.
    this.clock.setTimeout(() => {
      (targetClient as any)?.leave?.(4000, "Removed by the host.");
    }, 80);

    console.log(
      `Host removed ${target.name} (${target.sessionId}) from room ${this.roomId}`,
    );
  }

  private returnToLobby() {
    this.stopRoundTimer();
    this.stopSpectatorPowerSpawner();
    this.stopBoardDebuffSpawner();

    for (const timer of this.powerExpireTimers.values()) {
      timer?.clear?.();
    }

    for (const timer of this.effectExpireTimers.values()) {
      timer?.clear?.();
    }

    this.powerExpireTimers.clear();
    this.effectExpireTimers.clear();

    this.state.gameStarted = false;
    this.state.matchEnded = false;
    this.state.winningTeamId = -1;
    this.state.roundPhase = "lobby";
    this.state.roundNumber = 0;
    this.state.remainingSeconds = ROUND_SECONDS;
    this.state.roundMessage = "Waiting for the host to start the game.";
    this.state.boneCarrierSessionId = "";
    this.state.redScore = 0;
    this.state.blueScore = 0;
    this.state.greenScore = 0;
    this.state.yellowScore = 0;

    this.clearAllBoardDebuffItems();

    for (const player of this.state.players.values()) {
      this.resetPlayerForNewMatch(player);
      player.ready = false;
    }

    console.log(`Host returned room ${this.roomId} to lobby.`);
  }

  onDispose() {
    this.stopRoundTimer();
    this.stopSpectatorPowerSpawner();
    this.stopBoardDebuffSpawner();

    for (const timer of this.powerExpireTimers.values()) {
      timer?.clear?.();
    }

    for (const timer of this.effectExpireTimers.values()) {
      timer?.clear?.();
    }

    this.powerExpireTimers.clear();
    this.effectExpireTimers.clear();

    if (this.state?.joinCode) {
      DogBoneRoom.usedJoinCodes.delete(this.state.joinCode);
      DogBoneRoom.joinCodeToRoomId.delete(this.state.joinCode);
    }

    console.log(
      `DogBoneRoom disposed: ${this.roomId} (joinCode ${
        this.state?.joinCode ?? "n/a"
      })`,
    );
  }

  private handleMoveDog(client: Client, message: MoveDogMessage) {
    if (!this.state.gameStarted) return;
    if (this.state.roundPhase !== "playing") return;

    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    // Only the randomly selected runners are allowed to move.
    // Spectators stay in the room for future buffs/debuffs, but cannot move dogs.
    if (!player.isRunner) return;

    if (this.isPlayerFrozen(player)) return;

    let rowChange = Number(message?.rowChange ?? 0);
    let colChange = Number(message?.colChange ?? 0);

    // Only allow one-cell orthogonal movement commands.
    // Speed boost is applied server-side after this validation.
    if (!Number.isInteger(rowChange)) return;
    if (!Number.isInteger(colChange)) return;
    if (Math.abs(rowChange) + Math.abs(colChange) !== 1) return;

    if (this.isPlayerControlsReversed(player)) {
      rowChange *= -1;
      colChange *= -1;
    }

    if (this.isPlayerGlued(player)) {
      player.glueMoveAttemptCount += 1;

      // Glue blocks every first attempt, then allows the next one.
      if (player.glueMoveAttemptCount % 2 === 1) {
        this.state.roundMessage = `${player.name} is stuck in glue!`;
        return;
      }
    }

    const maxMoveDistance = this.isPlayerSpeedBoosted(player) ? 2 : 1;
    const requestedDistance = Number(message?.distance ?? 1);

    if (!Number.isInteger(requestedDistance)) return;
    if (requestedDistance < 1 || requestedDistance > 2) return;

    // Non-boosted players are clamped to 1 square, even if a modified client
    // tries to request a longer move.
    const moveDistance = Math.min(requestedDistance, maxMoveDistance);

    for (let step = 1; step <= moveDistance; step++) {
      const nextRow = player.row + rowChange * step;
      const nextCol = player.col + colChange * step;

      if (!this.isInsideMaze(nextRow, nextCol)) return;
    }

    for (let step = 0; step < moveDistance; step++) {
      player.row += rowChange;
      player.col += colChange;

      this.handlePlayerArrived(player);

      // A score can end the round during a speed-boosted two-cell move.
      if (this.state.roundPhase !== "playing") return;
    }
  }

  private handlePlayerArrived(player: Player) {
    if (this.state.roundPhase !== "playing") return;

    // Board debuffs can only be picked up by runners who are not already
    // carrying the bone or another held board power.
    this.tryPickupBoardDebuff(player);

    const centreCell = this.getCentreCell();
    const teamStartCell = this.getTeamStartCell(player.teamId);

    const isAtCentre =
      player.row === centreCell.row && player.col === centreCell.col;

    const isAtTeamStart =
      player.row === teamStartCell.row && player.col === teamStartCell.col;

    const noOneHasBone = this.state.boneCarrierSessionId === "";
    const thisPlayerHasBone =
      this.state.boneCarrierSessionId === player.sessionId;

    // Pick up the bone only if nobody else already has it and this runner is
    // not already carrying a board debuff. One player can hold only one item.
    if (!player.hasBone && !player.activePower && isAtCentre && noOneHasBone) {
      player.hasBone = true;
      this.state.boneCarrierSessionId = player.sessionId;
      this.state.roundMessage = `${player.name} collected the bone! Debuffs are appearing on the board!`;

      this.startBoardDebuffsAfterBoneCollected();
      return;
    }

    // If someone else already has the bone, this player cannot collect it.
    if (!player.hasBone && isAtCentre && !noOneHasBone) {
      return;
    }

    // Only the actual bone carrier can score.
    if (player.hasBone && thisPlayerHasBone && isAtTeamStart) {
      const points = player.hasDoublePoints ? 2 : 1;

      player.bonesScored += 1;
      player.pointsScored += points;

      const teamScore = this.addScoreForTeam(player.teamId, points);
      const teamName = this.getTeamName(player.teamId);
      const pointsText = points === 2 ? " for 2 points" : "";

      if (teamScore >= this.state.targetScore) {
        this.endMatch(
          `${player.name} scored${pointsText} and the ${teamName} team reached ${this.state.targetScore} points!`,
          player.teamId,
        );
        return;
      }

      this.endRound(
        `${player.name} scored${pointsText} for the ${teamName} team!`,
      );
    }
  }

  private startNewMatch() {
    this.stopRoundTimer();
    this.stopSpectatorPowerSpawner();
    this.stopBoardDebuffSpawner();

    for (const timer of this.powerExpireTimers.values()) {
      timer?.clear?.();
    }

    for (const timer of this.effectExpireTimers.values()) {
      timer?.clear?.();
    }

    this.powerExpireTimers.clear();
    this.effectExpireTimers.clear();

    this.state.gameStarted = true;
    this.state.matchEnded = false;
    this.state.winningTeamId = -1;

    // Every fresh match needs a fresh maze seed sequence.
    // This is what prevents New Game from replaying the same round 1, 2, 3... mazes.
    this.state.matchNumber += 1;
    this.state.roundNumber = 0;
    this.state.remainingSeconds = ROUND_SECONDS;
    this.state.roundPhase = "playing";
    this.state.matchEnded = false;
    this.state.winningTeamId = -1;
    this.state.boneCarrierSessionId = "";
    this.state.redScore = 0;
    this.state.blueScore = 0;
    this.state.greenScore = 0;
    this.state.yellowScore = 0;

    this.clearAllBoardDebuffItems();

    for (const player of this.state.players.values()) {
      this.resetPlayerForNewMatch(player);
    }

    this.startNewRound();
    this.startRoundTimer();
  }

  private resetPlayerForNewMatch(player: Player) {
    player.isRunner = false;
    player.hasBone = false;
    player.bonesScored = 0;
    player.pointsScored = 0;

    player.activePower = "";
    player.hasBoardPower = false;
    player.spectatorSlotTeamId = -1;
    player.spectatorSlotIndex = -1;
    player.powerExpiresAt = 0;

    player.isShielded = false;
    player.isSpeedBoosted = false;
    player.hasDoublePoints = false;
    player.isInvisible = false;
    player.shieldExpiresAt = 0;
    player.speedBoostExpiresAt = 0;
    player.invisibleExpiresAt = 0;

    player.isFrozen = false;
    player.isGlued = false;
    player.isControlsReversed = false;
    player.frozenExpiresAt = 0;
    player.gluedExpiresAt = 0;
    player.controlsReversedExpiresAt = 0;
    player.glueMoveAttemptCount = 0;

    this.placePlayerAtTeamStart(player);
  }

  private startNewRound() {
    this.state.roundNumber += 1;
    this.state.remainingSeconds = ROUND_SECONDS;
    this.state.roundPhase = "playing";
    this.state.boneCarrierSessionId = "";
    this.stopSpectatorPowerSpawner();
    this.stopBoardDebuffSpawner();
    this.clearAllBoardDebuffItems();
    this.clearAllSpectatorPowers(false);
    this.clearAllRunnerEffects();

    // First clear all old runner state.
    for (const player of this.state.players.values()) {
      player.isRunner = false;
      player.hasBone = false;
      this.placePlayerAtTeamStart(player);
    }

    const selectedNames: string[] = [];

    // Select one random runner from each team that has players.
    for (let teamId = 0; teamId < 4; teamId++) {
      const teamPlayers = Array.from(this.state.players.values()).filter(
        (player) => player.teamId === teamId,
      );

      if (teamPlayers.length === 0) continue;

      const selected =
        teamPlayers[Math.floor(Math.random() * teamPlayers.length)];

      selected.isRunner = true;
      selected.hasBone = false;
      this.placePlayerAtTeamStart(selected);

      selectedNames.push(`${selected.name} (${this.getTeamName(teamId)})`);
    }

    this.state.roundMessage =
      selectedNames.length > 0
        ? `Round ${this.state.roundNumber}: ${selectedNames.join(", ")} are running!`
        : `Round ${this.state.roundNumber}: Waiting for players.`;

    console.log(this.state.roundMessage);
    this.scheduleNextPowerSpawn(true);
  }

  private endMatch(message: string, winningTeamId: number) {
    if (this.state.roundPhase !== "playing") return;

    this.stopRoundTimer();
    this.stopSpectatorPowerSpawner();
    this.stopBoardDebuffSpawner();
    this.clearAllBoardDebuffItems();
    this.clearAllSpectatorPowers(false);
    this.clearAllRunnerEffects();

    this.state.roundPhase = "match_end";
    this.state.matchEnded = true;
    this.state.winningTeamId = winningTeamId;
    this.state.roundMessage = message;
    this.state.boneCarrierSessionId = "";

    for (const player of this.state.players.values()) {
      player.isRunner = false;
      player.hasBone = false;
      this.placePlayerAtTeamStart(player);
    }

    console.log(`Match ended: ${message}`);
    this.broadcast("match_end");
  }

  private endRound(message: string) {
    if (this.state.roundPhase !== "playing") return;

    this.stopSpectatorPowerSpawner();
    this.stopBoardDebuffSpawner();
    this.clearAllBoardDebuffItems();
    this.clearAllSpectatorPowers(false);
    this.clearAllRunnerEffects();

    this.state.roundPhase = "round_end";
    this.state.roundMessage = message;
    this.state.boneCarrierSessionId = "";

    // Hide/reset runners while the round-end message is shown.
    for (const player of this.state.players.values()) {
      player.isRunner = false;
      player.hasBone = false;
      this.placePlayerAtTeamStart(player);
    }

    console.log(`Round ended: ${message}`);

    this.clock.setTimeout(() => {
      if (!this.state.gameStarted) return;
      this.startNewRound();
    }, ROUND_END_DELAY_MS);
  }

  private startRoundTimer() {
    this.stopRoundTimer();

    this.roundTimer = this.clock.setInterval(() => {
      if (!this.state.gameStarted) return;
      if (this.state.roundPhase !== "playing") return;

      if (this.state.remainingSeconds > 0) {
        this.state.remainingSeconds -= 1;
      }

      if (this.state.remainingSeconds <= 0) {
        this.endRound("Time is up! New runners are being selected...");
      }
    }, 1000);
  }

  private stopRoundTimer() {
    if (!this.roundTimer) return;

    this.roundTimer.clear();
    this.roundTimer = undefined;
  }

  private addScoreForTeam(teamId: number, points = 1) {
    if (teamId === 0) this.state.redScore += points;
    else if (teamId === 1) this.state.blueScore += points;
    else if (teamId === 2) this.state.greenScore += points;
    else if (teamId === 3) this.state.yellowScore += points;

    return this.getTeamScore(teamId);
  }

  private getTeamScore(teamId: number) {
    if (teamId === 0) return this.state.redScore;
    if (teamId === 1) return this.state.blueScore;
    if (teamId === 2) return this.state.greenScore;
    if (teamId === 3) return this.state.yellowScore;

    return 0;
  }

  private placePlayerAtTeamStart(player: Player) {
    const startCell = this.getTeamStartCell(player.teamId);

    player.row = startCell.row;
    player.col = startCell.col;
    player.hasBone = false;
  }

  private getTeamStartCell(teamId: number): CellPoint {
    const middleRow = Math.floor(MAZE_ROWS / 2);
    const middleCol = Math.floor(MAZE_COLS / 2);

    if (teamId === 0) {
      return { row: 0, col: middleCol };
    }

    if (teamId === 1) {
      return { row: middleRow, col: MAZE_COLS - 1 };
    }

    if (teamId === 2) {
      return { row: MAZE_ROWS - 1, col: middleCol };
    }

    return { row: middleRow, col: 0 };
  }

  private getCentreCell(): CellPoint {
    return {
      row: Math.floor(MAZE_ROWS / 2),
      col: Math.floor(MAZE_COLS / 2),
    };
  }

  private isInsideMaze(row: number, col: number) {
    return row >= 0 && row < MAZE_ROWS && col >= 0 && col < MAZE_COLS;
  }

  private handleCastPower(client: Client, message: CastPowerMessage) {
    if (!this.state.gameStarted) return;
    if (this.state.roundPhase !== "playing") return;

    const caster = this.state.players.get(client.sessionId);
    if (!caster) return;
    if (!caster.activePower) return;

    const targetSessionId =
      typeof message?.targetSessionId === "string"
        ? message.targetSessionId
        : "";

    if (!targetSessionId) return;

    const target = this.state.players.get(targetSessionId);
    if (!target) return;
    if (!target.isRunner) return;

    const power = caster.activePower as PowerType;

    if (caster.isRunner) {
      this.handleRunnerBoardPowerCast(caster, target, power);
      return;
    }

    this.handleSpectatorPowerCast(caster, target, power);
  }

  private handleSpectatorPowerCast(
    caster: Player,
    target: Player,
    power: PowerType,
  ) {
    if (this.isBuffPower(power)) {
      // Buffs can only target your own runner.
      if (target.teamId !== caster.teamId) return;

      if (power === "shield") {
        this.applyShield(target);
        this.state.roundMessage = `${caster.name} shielded ${target.name}!`;
      } else if (power === "speed") {
        this.applySpeedBoost(target);
        this.state.roundMessage = `${caster.name} speed boosted ${target.name}!`;
      } else if (power === "double_points") {
        this.applyDoublePoints(target);
        this.state.roundMessage = `${caster.name} gave ${target.name} a x2 scoring chance!`;
      } else if (power === "invisible") {
        this.applyInvisible(target);
        this.state.roundMessage = `${caster.name} made ${target.name} invisible!`;
      }

      this.clearSpectatorPower(caster, true);
      return;
    }

    if (this.isDebuffPower(power)) {
      // Spectator debuffs can only target opponent runners.
      if (target.teamId === caster.teamId) return;

      if (this.isPlayerDebuffImmune(target)) {
        this.state.roundMessage = `${target.name}'s protection blocked ${caster.name}'s ${this.getPowerName(power)}!`;
        this.clearSpectatorPower(caster, true);
        return;
      }

      if (!this.applyDebuffPower(caster, target, power)) return;

      this.clearSpectatorPower(caster, true);
    }
  }

  private handleRunnerBoardPowerCast(
    caster: Player,
    target: Player,
    power: PowerType,
  ) {
    // Runners can only cast debuffs they picked up from the board.
    if (!caster.hasBoardPower) return;
    if (!this.isDebuffPower(power)) return;
    if (caster.hasBone) return;

    const targetHasBone =
      target.hasBone && this.state.boneCarrierSessionId === target.sessionId;

    if (!targetHasBone) return;

    // Board debuffs are designed as a catch-up mechanic against the opposing
    // player carrying the bone, not as a way to sabotage your own team.
    if (target.teamId === caster.teamId) return;

    if (this.isPlayerDebuffImmune(target)) {
      this.state.roundMessage = `${target.name}'s protection blocked ${caster.name}'s ${this.getPowerName(power)}!`;
      this.clearRunnerHeldBoardPower(caster);
      return;
    }

    if (!this.applyDebuffPower(caster, target, power)) return;

    this.clearRunnerHeldBoardPower(caster);
  }

  private applyDebuffPower(caster: Player, target: Player, power: PowerType) {
    if (power === "freeze") {
      this.applyFreeze(target);
      this.state.roundMessage = `${caster.name} froze ${target.name}!`;
      return true;
    }

    if (power === "glue") {
      this.applyGlue(target);
      this.state.roundMessage = `${caster.name} glued ${target.name}!`;
      return true;
    }

    if (power === "reverse") {
      this.applyReverseControls(target);
      this.state.roundMessage = `${caster.name} reversed ${target.name}'s controls!`;
      return true;
    }

    if (power === "drop_bone") {
      if (!this.dropBoneFromPlayer(target)) return false;

      this.state.roundMessage = `${caster.name} made ${target.name} drop the bone! The bone is back in the centre.`;
      return true;
    }

    return false;
  }

  private startBoardDebuffsAfterBoneCollected() {
    if (!this.state.gameStarted) return;
    if (this.state.roundPhase !== "playing") return;
    if (!this.state.boneCarrierSessionId) return;

    this.clearAllBoardDebuffItems();
    this.spawnBoardDebuffItem();
    this.scheduleNextBoardDebuffSpawn(true);
  }

  private scheduleNextBoardDebuffSpawn(resetExistingTimer = false) {
    if (!this.state.gameStarted) return;
    if (this.state.roundPhase !== "playing") return;
    if (!this.state.boneCarrierSessionId) return;

    if (resetExistingTimer) {
      this.stopBoardDebuffSpawner();
    }

    if (this.boardDebuffSpawnTimer) return;

    const delay = this.getRandomInt(
      BOARD_DEBUFF_SPAWN_MIN_MS,
      BOARD_DEBUFF_SPAWN_MAX_MS,
    );

    this.boardDebuffSpawnTimer = this.clock.setTimeout(() => {
      this.boardDebuffSpawnTimer = undefined;

      if (!this.state.gameStarted) return;
      if (this.state.roundPhase !== "playing") return;
      if (!this.state.boneCarrierSessionId) return;

      this.spawnBoardDebuffItem();
      this.scheduleNextBoardDebuffSpawn(false);
    }, delay);
  }

  private stopBoardDebuffSpawner() {
    if (!this.boardDebuffSpawnTimer) return;

    this.boardDebuffSpawnTimer.clear();
    this.boardDebuffSpawnTimer = undefined;
  }

  private spawnBoardDebuffItem() {
    if (this.state.boardPowerItems.size >= MAX_ACTIVE_BOARD_DEBUFF_ITEMS) {
      return false;
    }

    const cell = this.getRandomBoardDebuffCell();
    if (!cell) return false;

    const item = new BoardPowerItem();
    item.itemId = `board-power-${this.state.roundNumber}-${++this.boardDebuffItemCounter}`;
    item.powerType = this.getRandomBoardDebuffType();
    item.row = cell.row;
    item.col = cell.col;

    this.state.boardPowerItems.set(item.itemId, item);

    return true;
  }

  private tryPickupBoardDebuff(player: Player) {
    if (!player.isRunner) return false;
    if (!this.state.boneCarrierSessionId) return false;
    if (this.state.boneCarrierSessionId === player.sessionId) return false;
    if (player.hasBone) return false;
    if (player.activePower) return false;

    for (const [itemId, item] of this.state.boardPowerItems.entries()) {
      if (item.row !== player.row || item.col !== player.col) continue;

      const power = item.powerType as PowerType;
      if (!this.isDebuffPower(power)) return false;

      this.state.boardPowerItems.delete(itemId);
      this.giveRunnerBoardPower(player, power);

      this.state.roundMessage = `${player.name} picked up ${this.getPowerName(power)}! Click the opponent carrying the bone within 10 seconds.`;
      return true;
    }

    return false;
  }

  private giveRunnerBoardPower(player: Player, power: PowerType) {
    this.clearPowerExpireTimer(player.sessionId);

    player.activePower = power;
    player.hasBoardPower = true;
    player.spectatorSlotTeamId = -1;
    player.spectatorSlotIndex = -1;
    player.powerExpiresAt = Date.now() + POWER_EXPIRE_MS;

    this.powerExpireTimers.set(
      player.sessionId,
      this.clock.setTimeout(() => {
        const current = this.state.players.get(player.sessionId);
        if (!current) return;

        if (
          current.hasBoardPower &&
          current.activePower &&
          Date.now() >= current.powerExpiresAt
        ) {
          this.clearRunnerHeldBoardPower(current);
        }
      }, POWER_EXPIRE_MS),
    );
  }

  private clearRunnerHeldBoardPower(player: Player) {
    this.clearPowerExpireTimer(player.sessionId);

    player.activePower = "";
    player.hasBoardPower = false;
    player.spectatorSlotTeamId = -1;
    player.spectatorSlotIndex = -1;
    player.powerExpiresAt = 0;
  }

  private clearAllBoardDebuffItems() {
    this.state.boardPowerItems.clear();
  }

  private getRandomBoardDebuffCell(): CellPoint | undefined {
    const possibleCells: CellPoint[] = [];

    for (let row = 0; row < MAZE_ROWS; row++) {
      for (let col = 0; col < MAZE_COLS; col++) {
        if (this.isSpecialBoardCell(row, col)) continue;
        if (this.isRunnerOnCell(row, col)) continue;
        if (this.isBoardDebuffOnCell(row, col)) continue;

        possibleCells.push({ row, col });
      }
    }

    if (possibleCells.length === 0) return undefined;

    return possibleCells[Math.floor(Math.random() * possibleCells.length)];
  }

  private isSpecialBoardCell(row: number, col: number) {
    const centreCell = this.getCentreCell();
    if (row === centreCell.row && col === centreCell.col) return true;

    for (let teamId = 0; teamId < 4; teamId++) {
      const startCell = this.getTeamStartCell(teamId);
      if (row === startCell.row && col === startCell.col) return true;
    }

    return false;
  }

  private isRunnerOnCell(row: number, col: number) {
    for (const player of this.state.players.values()) {
      if (!player.isRunner) continue;
      if (player.row === row && player.col === col) return true;
    }

    return false;
  }

  private isBoardDebuffOnCell(row: number, col: number) {
    for (const item of this.state.boardPowerItems.values()) {
      if (item.row === row && item.col === col) return true;
    }

    return false;
  }

  private scheduleNextPowerSpawn(resetExistingTimer = false) {
    if (!this.state.gameStarted) return;
    if (this.state.roundPhase !== "playing") return;

    if (resetExistingTimer) {
      this.stopSpectatorPowerSpawner();
    }

    if (this.spectatorSpawnTimer) return;

    const delay = this.getRandomInt(POWER_SPAWN_MIN_MS, POWER_SPAWN_MAX_MS);

    this.spectatorSpawnTimer = this.clock.setTimeout(() => {
      this.spectatorSpawnTimer = undefined;

      if (!this.state.gameStarted) return;
      if (this.state.roundPhase !== "playing") return;

      this.spawnSpectatorPower();
      this.scheduleNextPowerSpawn(false);
    }, delay);
  }

  private stopSpectatorPowerSpawner() {
    if (!this.spectatorSpawnTimer) return;

    this.spectatorSpawnTimer.clear();
    this.spectatorSpawnTimer = undefined;
  }

  private spawnSpectatorPower() {
    if (this.getActiveSpectatorPowerCount() >= MAX_ACTIVE_SPECTATOR_POWERS) {
      return false;
    }

    const eligibleSpectators = Array.from(this.state.players.values()).filter(
      (player) => {
        if (player.isRunner) return false;
        if (player.activePower) return false;
        if (player.teamId < 0 || player.teamId > 3) return false;

        return this.getOpenSlotIndicesForTeam(player.teamId).length > 0;
      },
    );

    if (eligibleSpectators.length === 0) return false;

    const spectator =
      eligibleSpectators[Math.floor(Math.random() * eligibleSpectators.length)];

    const openSlots = this.getOpenSlotIndicesForTeam(spectator.teamId);
    if (openSlots.length === 0) return false;

    const slotIndex = openSlots[Math.floor(Math.random() * openSlots.length)];
    const power = this.getRandomPowerType();

    spectator.activePower = power;
    spectator.spectatorSlotTeamId = spectator.teamId;
    spectator.spectatorSlotIndex = slotIndex;
    spectator.powerExpiresAt = Date.now() + POWER_EXPIRE_MS;

    this.clearPowerExpireTimer(spectator.sessionId);

    this.powerExpireTimers.set(
      spectator.sessionId,
      this.clock.setTimeout(() => {
        const current = this.state.players.get(spectator.sessionId);
        if (!current) return;

        if (current.activePower && Date.now() >= current.powerExpiresAt) {
          this.clearSpectatorPower(current, true);
        }
      }, POWER_EXPIRE_MS),
    );

    const powerName = this.getPowerName(power);
    this.state.roundMessage = `${spectator.name} received ${powerName}!`;

    return true;
  }

  private clearSpectatorPower(player: Player, scheduleReplacement: boolean) {
    this.clearPowerExpireTimer(player.sessionId);

    player.activePower = "";
    player.hasBoardPower = false;
    player.spectatorSlotTeamId = -1;
    player.spectatorSlotIndex = -1;
    player.powerExpiresAt = 0;

    if (
      scheduleReplacement &&
      this.state.gameStarted &&
      this.state.roundPhase === "playing"
    ) {
      this.scheduleNextPowerSpawn(true);
    }
  }

  private clearAllSpectatorPowers(scheduleReplacement: boolean) {
    for (const player of this.state.players.values()) {
      this.clearSpectatorPower(player, false);
    }

    if (scheduleReplacement) {
      this.scheduleNextPowerSpawn(true);
    }
  }

  private getActiveSpectatorPowerCount() {
    let count = 0;

    for (const player of this.state.players.values()) {
      if (player.isRunner) continue;
      if (player.hasBoardPower) continue;
      if (player.activePower) count += 1;
    }

    return count;
  }

  private getOpenSlotIndicesForTeam(teamId: number) {
    const openSlots: number[] = [];

    for (let slotIndex = 0; slotIndex < SPECTATOR_SLOTS_PER_TEAM; slotIndex++) {
      if (!this.isSpectatorSlotOccupied(teamId, slotIndex)) {
        openSlots.push(slotIndex);
      }
    }

    return openSlots;
  }

  private isSpectatorSlotOccupied(teamId: number, slotIndex: number) {
    for (const player of this.state.players.values()) {
      if (!player.activePower) continue;

      if (
        player.spectatorSlotTeamId === teamId &&
        player.spectatorSlotIndex === slotIndex
      ) {
        return true;
      }
    }

    return false;
  }

  private applyShield(player: Player) {
    player.isShielded = true;
    player.shieldExpiresAt = Date.now() + SHIELD_MS;

    this.setEffectExpiryTimer(player, "shield", SHIELD_MS, () => {
      if (Date.now() >= player.shieldExpiresAt) this.clearShield(player);
    });
  }

  private applySpeedBoost(player: Player) {
    player.isSpeedBoosted = true;
    player.speedBoostExpiresAt = Date.now() + SPEED_BOOST_MS;

    this.setEffectExpiryTimer(player, "speed", SPEED_BOOST_MS, () => {
      if (Date.now() >= player.speedBoostExpiresAt) {
        this.clearSpeedBoost(player);
      }
    });
  }

  private applyDoublePoints(player: Player) {
    // Cleared at the end of the round, not after a timer.
    player.hasDoublePoints = true;
  }

  private applyInvisible(player: Player) {
    player.isInvisible = true;
    player.invisibleExpiresAt = Date.now() + INVISIBLE_MS;

    this.setEffectExpiryTimer(player, "invisible", INVISIBLE_MS, () => {
      if (Date.now() >= player.invisibleExpiresAt) {
        this.clearInvisible(player);
      }
    });
  }

  private applyFreeze(player: Player) {
    player.isFrozen = true;
    player.frozenExpiresAt = Date.now() + FREEZE_MS;

    this.setEffectExpiryTimer(player, "freeze", FREEZE_MS, () => {
      if (Date.now() >= player.frozenExpiresAt) this.clearFrozen(player);
    });
  }

  private applyGlue(player: Player) {
    player.isGlued = true;
    player.gluedExpiresAt = Date.now() + GLUE_MS;
    player.glueMoveAttemptCount = 0;

    this.setEffectExpiryTimer(player, "glue", GLUE_MS, () => {
      if (Date.now() >= player.gluedExpiresAt) this.clearGlue(player);
    });
  }

  private applyReverseControls(player: Player) {
    player.isControlsReversed = true;
    player.controlsReversedExpiresAt = Date.now() + REVERSE_CONTROLS_MS;

    this.setEffectExpiryTimer(player, "reverse", REVERSE_CONTROLS_MS, () => {
      if (Date.now() >= player.controlsReversedExpiresAt) {
        this.clearReverseControls(player);
      }
    });
  }

  private dropBoneFromPlayer(player: Player) {
    const isBoneCarrier = this.state.boneCarrierSessionId === player.sessionId;

    if (!isBoneCarrier || !player.hasBone) return false;

    player.hasBone = false;
    this.state.boneCarrierSessionId = "";
    this.stopBoardDebuffSpawner();
    this.clearAllBoardDebuffItems();

    return true;
  }

  private setEffectExpiryTimer(
    player: Player,
    effectName: string,
    durationMs: number,
    onExpire: () => void,
  ) {
    const timerKey = `${player.sessionId}:${effectName}`;
    this.clearEffectTimer(timerKey);

    this.effectExpireTimers.set(
      timerKey,
      this.clock.setTimeout(() => {
        const current = this.state.players.get(player.sessionId);
        if (!current) return;

        onExpire();
      }, durationMs),
    );
  }

  private isPlayerShielded(player: Player) {
    if (!player.isShielded) return false;

    if (Date.now() >= player.shieldExpiresAt) {
      this.clearShield(player);
      return false;
    }

    return true;
  }

  private isPlayerSpeedBoosted(player: Player) {
    if (!player.isSpeedBoosted) return false;

    if (Date.now() >= player.speedBoostExpiresAt) {
      this.clearSpeedBoost(player);
      return false;
    }

    return true;
  }

  private isPlayerInvisible(player: Player) {
    if (!player.isInvisible) return false;

    if (Date.now() >= player.invisibleExpiresAt) {
      this.clearInvisible(player);
      return false;
    }

    return true;
  }

  private isPlayerFrozen(player: Player) {
    if (!player.isFrozen) return false;

    if (Date.now() >= player.frozenExpiresAt) {
      this.clearFrozen(player);
      return false;
    }

    return true;
  }

  private isPlayerGlued(player: Player) {
    if (!player.isGlued) return false;

    if (Date.now() >= player.gluedExpiresAt) {
      this.clearGlue(player);
      return false;
    }

    return true;
  }

  private isPlayerControlsReversed(player: Player) {
    if (!player.isControlsReversed) return false;

    if (Date.now() >= player.controlsReversedExpiresAt) {
      this.clearReverseControls(player);
      return false;
    }

    return true;
  }

  private isPlayerDebuffImmune(player: Player) {
    return this.isPlayerShielded(player) || this.isPlayerInvisible(player);
  }

  private clearShield(player: Player) {
    player.isShielded = false;
    player.shieldExpiresAt = 0;

    this.clearEffectTimer(`${player.sessionId}:shield`);
  }

  private clearSpeedBoost(player: Player) {
    player.isSpeedBoosted = false;
    player.speedBoostExpiresAt = 0;

    this.clearEffectTimer(`${player.sessionId}:speed`);
  }

  private clearInvisible(player: Player) {
    player.isInvisible = false;
    player.invisibleExpiresAt = 0;

    this.clearEffectTimer(`${player.sessionId}:invisible`);
  }

  private clearFrozen(player: Player) {
    player.isFrozen = false;
    player.frozenExpiresAt = 0;

    this.clearEffectTimer(`${player.sessionId}:freeze`);
  }

  private clearGlue(player: Player) {
    player.isGlued = false;
    player.gluedExpiresAt = 0;
    player.glueMoveAttemptCount = 0;

    this.clearEffectTimer(`${player.sessionId}:glue`);
  }

  private clearReverseControls(player: Player) {
    player.isControlsReversed = false;
    player.controlsReversedExpiresAt = 0;

    this.clearEffectTimer(`${player.sessionId}:reverse`);
  }

  private clearPlayerRunnerEffects(player: Player) {
    player.isShielded = false;
    player.isSpeedBoosted = false;
    player.hasDoublePoints = false;
    player.isInvisible = false;
    player.shieldExpiresAt = 0;
    player.speedBoostExpiresAt = 0;
    player.invisibleExpiresAt = 0;

    player.isFrozen = false;
    player.isGlued = false;
    player.isControlsReversed = false;
    player.frozenExpiresAt = 0;
    player.gluedExpiresAt = 0;
    player.controlsReversedExpiresAt = 0;
    player.glueMoveAttemptCount = 0;
  }

  private clearAllRunnerEffects() {
    for (const player of this.state.players.values()) {
      player.isShielded = false;
      player.isSpeedBoosted = false;
      player.hasDoublePoints = false;
      player.isInvisible = false;
      player.isFrozen = false;
      player.isGlued = false;
      player.isControlsReversed = false;
      player.hasBoardPower = false;
      player.activePower = "";
      player.powerExpiresAt = 0;
      player.spectatorSlotTeamId = -1;
      player.spectatorSlotIndex = -1;

      player.shieldExpiresAt = 0;
      player.speedBoostExpiresAt = 0;
      player.invisibleExpiresAt = 0;
      player.frozenExpiresAt = 0;
      player.gluedExpiresAt = 0;
      player.controlsReversedExpiresAt = 0;
      player.glueMoveAttemptCount = 0;

      this.clearEffectTimers(player.sessionId);
    }
  }

  private clearPowerExpireTimer(sessionId: string) {
    const timer = this.powerExpireTimers.get(sessionId);

    if (timer) {
      timer.clear();
      this.powerExpireTimers.delete(sessionId);
    }
  }

  private clearEffectTimer(timerKey: string) {
    const timer = this.effectExpireTimers.get(timerKey);

    if (timer) {
      timer.clear();
      this.effectExpireTimers.delete(timerKey);
    }
  }

  private clearEffectTimers(sessionId: string) {
    this.clearEffectTimer(`${sessionId}:shield`);
    this.clearEffectTimer(`${sessionId}:speed`);
    this.clearEffectTimer(`${sessionId}:invisible`);
    this.clearEffectTimer(`${sessionId}:freeze`);
    this.clearEffectTimer(`${sessionId}:glue`);
    this.clearEffectTimer(`${sessionId}:reverse`);
  }

  private isBuffPower(power: PowerType) {
    return (
      power === "shield" ||
      power === "speed" ||
      power === "double_points" ||
      power === "invisible"
    );
  }

  private isDebuffPower(power: PowerType) {
    return (
      power === "freeze" ||
      power === "glue" ||
      power === "reverse" ||
      power === "drop_bone"
    );
  }

  private getRandomBoardDebuffType(): PowerType {
    return this.getWeightedPowerType(BOARD_DEBUFF_WEIGHTS, "freeze");
  }

  private getRandomPowerType(): PowerType {
    return this.getWeightedPowerType(POWER_WEIGHTS, "shield");
  }

  private getWeightedPowerType(
    weights: { type: PowerType; weight: number }[],
    fallback: PowerType,
  ): PowerType {
    const totalWeight = weights.reduce((total, item) => total + item.weight, 0);
    let roll = Math.random() * totalWeight;

    for (const item of weights) {
      roll -= item.weight;
      if (roll <= 0) return item.type;
    }

    return fallback;
  }

  private getPowerName(power: PowerType) {
    if (power === "shield") return "Shield";
    if (power === "speed") return "Speed Boost";
    if (power === "double_points") return "x2 Points";
    if (power === "invisible") return "Invisible";
    if (power === "freeze") return "Freeze";
    if (power === "glue") return "Glue";
    if (power === "reverse") return "Reverse Controls";
    if (power === "drop_bone") return "Drop Bone";

    return "Power";
  }

  private setTargetScoreFromMessage(
    message?: SetTargetScoreMessage | NewGameMessage,
  ) {
    const nextTargetScore = this.getValidTargetScore(message?.targetScore);

    if (nextTargetScore === undefined) return;

    this.state.targetScore = nextTargetScore;
  }

  private getValidTargetScore(value: unknown) {
    const numericValue = Number(value);

    if (!Number.isFinite(numericValue)) return undefined;

    return Math.round(
      Math.max(MIN_TARGET_SCORE, Math.min(MAX_TARGET_SCORE, numericValue)),
    );
  }

  private getRandomInt(minInclusive: number, maxInclusive: number) {
    return Math.floor(
      minInclusive + Math.random() * (maxInclusive - minInclusive + 1),
    );
  }

  private getTeamName(teamId: number) {
    if (teamId === 0) return "Red";
    if (teamId === 1) return "Blue";
    if (teamId === 2) return "Green";
    return "Yellow";
  }
}
