import express, { Request, Response } from "express";
import cors from "cors";
import http from "http";
import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { DogBoneRoom } from "./rooms/DogBoneRoom";

const app = express();

// Keep CORS open because the itch.io HTML5 iframe can be served from itch.io
// or an itch.io CDN domain. This is safe here because the game uses room codes,
// not cookies or private account data.
app.use(cors());
app.use(express.json());

app.get("/", (_req: Request, res: Response) => {
  res.json({
    ok: true,
    name: "Dog & Bone server",
    health: "/health",
  });
});

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

app.get("/rooms/find", (req: Request, res: Response) => {
  const joinCode = String(req.query.joinCode ?? "").trim();

  if (!/^\d{5}$/.test(joinCode)) {
    res.status(400).json({
      error: "Invalid join code. Expected a 5-digit numeric code.",
    });
    return;
  }

  const roomId = DogBoneRoom.joinCodeToRoomId.get(joinCode);

  if (!roomId) {
    res.status(404).json({
      error: "Room not found for that join code.",
    });
    return;
  }

  res.json({ roomId });
});

const server = http.createServer(app);

const gameServer = new Server({
  transport: new WebSocketTransport({ server }),
});

gameServer.define("dogbone", DogBoneRoom);

const port = Number(process.env.PORT || 2567);
const host = "0.0.0.0";

server.listen(port, host, () => {
  console.log(`Dog & Bone server listening on ${host}:${port}`);
  console.log("Health check available at /health");
});
