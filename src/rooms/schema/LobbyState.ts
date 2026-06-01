import { Schema, MapSchema, type } from "@colyseus/schema";
import { Player } from "./Player";

export class BoardPowerItem extends Schema {
  @type("string") itemId = "";
  @type("string") powerType = "";
  @type("number") row = 0;
  @type("number") col = 0;
}

export class LobbyState extends Schema {
  @type("string") hostId = "";
  @type("string") joinCode = "";

  @type("boolean") gameStarted = false;

  // Host-selected number of team points needed to win the match.
  @type("number") targetScore = 5;

  // Results state.
  @type("boolean") matchEnded = false;
  @type("number") winningTeamId = -1;

  // lobby | playing | round_end
  @type("string") roundPhase = "lobby";
  // Increments every time the host starts a fresh match.
  // Used by the client maze seed so New Game does not reuse old mazes.
  @type("number") matchNumber = 0;
  @type("number") roundNumber = 0;

  @type("number") remainingSeconds = 60;
  @type("string") roundMessage = "";

  // Empty string means the bone is still available in the centre.
  // When a player collects it, this stores that player's sessionId.
  @type("string") boneCarrierSessionId = "";

  @type("number") redScore = 0;
  @type("number") blueScore = 0;
  @type("number") greenScore = 0;
  @type("number") yellowScore = 0;

  @type({ map: Player }) players = new MapSchema<Player>();

  // Debuff pickups that appear directly on the maze after the bone is collected.
  @type({ map: BoardPowerItem }) boardPowerItems =
    new MapSchema<BoardPowerItem>();
}
