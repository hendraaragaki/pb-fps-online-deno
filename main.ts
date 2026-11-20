// PB FPS Online — standalone multiplayer FPS game server (Deno port).
// Ported line-for-line from the Node.js implementation
// (~/workspace/pb-fps-render/server.js), keeping PROTOCOL.md exactly (v1).
// Transport: WebSocket, JSON messages. Server is authoritative for
// HP / damage / scores / bots. No auth, no database, no persistence.
// Positions: flat ground plane x,z (metres), yaw radians, 0 = facing -Z.
// Runs on Deno Deploy (free tier) and locally: `deno task start`.

const PORT = Number(Deno.env.get("PORT") ?? "8000");

const MAPS = ["Downtown", "Luxville", "Midtown", "Burning Hall", "Safe House", "Crackdown"];
const MODES = ["tdm", "ffa"];
const MATCH_LENGTH = 300; // seconds
const RESPAWN_DELAY_MS = 3000;
const PLAYER_HP = 100;
const TDM_TARGET = 50;
const FFA_TARGET = 15;
const TEAM_SIZE = 8;
const MOVE_CLAMP = 31;
const PLAYER_RADIUS = 0.6;
const EMPTY_ROOM_TTL_MS = 5 * 60 * 1000;
const ENDED_ROOM_TTL_MS = 60 * 1000;

interface Weapon {
  dmg: number;
  rpm: number;
  range: number;
  auto: boolean;
  mag: number;
  reload: number;
  pellets?: number;
}

export const WEAPONS: Record<string, Weapon> = {
  k5: { dmg: 25, rpm: 600, range: 40, auto: true, mag: 30, reload: 1.6 },
  ak47: { dmg: 34, rpm: 600, range: 60, auto: true, mag: 30, reload: 2.2 },
  m4a1: { dmg: 30, rpm: 700, range: 55, auto: true, mag: 30, reload: 2.0 },
  mp5: { dmg: 22, rpm: 800, range: 35, auto: true, mag: 30, reload: 1.8 },
  awp: { dmg: 100, rpm: 45, range: 100, auto: false, mag: 5, reload: 3.0 },
  m1887: { dmg: 12, rpm: 70, range: 15, auto: false, mag: 6, reload: 2.8, pellets: 8 },
};

const CT_CHARACTERS = ["Keen Eyes", "Acid Pol", "Hide", "Leopard"];
const FR_CHARACTERS = ["Rica", "Tarantula", "D-Fox", "Viper Red"];
const CT_BOT_NAMES = ["Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel"];
const FR_BOT_NAMES = ["Viper", "Cobra", "Raven", "Hawk", "Falcon", "Wolf", "Ghost"];

export interface Box {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
}

export interface Entity {
  id: string;
  name: string;
  team: string;
  character: string;
  weapon: string;
  x: number;
  z: number;
  yaw: number;
  hp: number;
  alive: boolean;
  kills: number;
  deaths: number;
  isBot: boolean;
  spawnIndex: number;
  ws?: WebSocket | null;
  waypoint?: { x: number; z: number } | null;
  respawnAt: number;
  nextShotAt: number;
}

export interface Room {
  code: string;
  map: string;
  mode: string;
  hostId: string | null;
  state: "lobby" | "playing" | "ended";
  timeLeft: number;
  scores: { CT: number; FR: number };
  players: Map<string, Entity>;
  bots: Map<string, Entity>;
  obstacles: Box[];
  botCounter: number;
  spawnCounter: number;
  createdAt: number;
  emptySince: number | null;
  endedAt: number | null;
  respawnTimers: Set<ReturnType<typeof setTimeout>>;
}

// ---------------------------------------------------------------------------
// Deterministic map obstacles (server & client MUST agree)
// mulberry32 seeded by sum of char codes of the map name.
// 26 boxes: w = 2+rnd()*4, d = 2+rnd()*4, x = -28+rnd()*56, z = -28+rnd()*56.
// Skip if within 6 of either spawn. Height = 2+rnd()*3.
// ---------------------------------------------------------------------------
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function mapObstacles(map: string): Box[] {
  const seed = [...map].reduce((s, c) => s + c.charCodeAt(0), 0);
  const rnd = mulberry32(seed);
  const boxes: Box[] = [];
  const spawns = [{ x: -26, z: 0 }, { x: 26, z: 0 }];
  for (let i = 0; i < 26; i++) {
    const w = 2 + rnd() * 4;
    const d = 2 + rnd() * 4;
    const x = -28 + rnd() * 56;
    const z = -28 + rnd() * 56;
    if (spawns.some((s) => Math.hypot(x - s.x, z - s.z) < 6)) continue;
    const h = 2 + rnd() * 3;
    boxes.push({ x, z, w, d, h });
  }
  return boxes;
}

// Circle-vs-AABB push-out, radius 0.6. Mutates/returns {x, z}.
export function pushOutObstacles(
  x: number,
  z: number,
  obstacles: Box[],
): { x: number; z: number } {
  for (const b of obstacles) {
    const hx = b.w / 2, hz = b.d / 2;
    const cx = Math.max(b.x - hx, Math.min(x, b.x + hx));
    const cz = Math.max(b.z - hz, Math.min(z, b.z + hz));
    const dx = x - cx, dz = z - cz;
    const distSq = dx * dx + dz * dz;
    if (distSq >= PLAYER_RADIUS * PLAYER_RADIUS) continue;
    if (distSq > 1e-9) {
      const dist = Math.sqrt(distSq);
      const push = (PLAYER_RADIUS - dist) / dist;
      x += dx * push;
      z += dz * push;
    } else {
      // Centre inside the box: push out along smallest penetration axis.
      const px = hx + PLAYER_RADIUS - Math.abs(x - b.x);
      const pz = hz + PLAYER_RADIUS - Math.abs(z - b.z);
      if (px < pz) x += x >= b.x ? px : -px;
      else z += z >= b.z ? pz : -pz;
    }
  }
  return { x, z };
}

export function clampMove(
  x: number,
  z: number,
  obstacles: Box[],
): { x: number; z: number } {
  x = Math.max(-MOVE_CLAMP, Math.min(MOVE_CLAMP, x));
  z = Math.max(-MOVE_CLAMP, Math.min(MOVE_CLAMP, z));
  return pushOutObstacles(x, z, obstacles);
}

// Forward vector for a yaw (yaw 0 = facing -Z).
function forwardOf(yaw: number): { x: number; z: number } {
  return { x: -Math.sin(yaw), z: -Math.cos(yaw) };
}
function yawToFace(dx: number, dz: number): number {
  return Math.atan2(-dx, -dz);
}

// ---------------------------------------------------------------------------
// Room / player state
// ---------------------------------------------------------------------------
const rooms = new Map<string, Room>(); // code -> room

function newId(prefix: string): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return prefix + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomCode(): string {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let code: string;
  do {
    code = "";
    for (let i = 0; i < 4; i++) code += letters[Math.floor(Math.random() * 26)];
  } while (rooms.has(code));
  return code;
}

function validWeapon(w: unknown): string {
  return typeof w === "string" && WEAPONS[w] ? w : "k5";
}

function defaultCharacter(team: string): string {
  return team === "FR" ? "Rica" : "Keen Eyes";
}

function spawnFor(room: Room, entity: Entity): { x: number; z: number } {
  // Small deterministic offset per entity so 8 spawns don't stack exactly.
  const off = entity.spawnIndex || 0;
  const ox = ((off % 3) - 1) * 1.2;
  const oz = ((Math.floor(off / 3) % 3) - 1) * 1.2;
  if (room.mode === "ffa") {
    const angle = (off * Math.PI * 2) / 8;
    return { x: 24 * Math.cos(angle) + ox * 0.5, z: 24 * Math.sin(angle) + oz * 0.5 };
  }
  const base = entity.team === "FR" ? { x: 26, z: 0 } : { x: -26, z: 0 };
  return { x: base.x + ox, z: base.z + oz };
}

function publicEntry(e: Entity) {
  return {
    id: e.id, name: e.name, team: e.team, character: e.character,
    weapon: e.weapon, x: e.x, z: e.z, yaw: e.yaw, hp: e.hp,
    alive: e.alive, kills: e.kills, deaths: e.deaths, isBot: !!e.isBot,
  };
}

function publicRoom(room: Room) {
  return {
    code: room.code, map: room.map, mode: room.mode, hostId: room.hostId,
    state: room.state, timeLeft: Math.max(0, Math.ceil(room.timeLeft)),
    scores: { ...room.scores },
    players: [...room.players.values()].map(publicEntry),
    bots: [...room.bots.values()].map(publicEntry),
  };
}

function createRoom(map: unknown, mode: unknown): Room {
  const room: Room = {
    code: randomCode(),
    map: typeof map === "string" && MAPS.includes(map) ? map : "Downtown",
    mode: typeof mode === "string" && MODES.includes(mode) ? mode : "tdm",
    hostId: null,
    state: "lobby", // lobby | playing | ended
    timeLeft: MATCH_LENGTH,
    scores: { CT: 0, FR: 0 },
    players: new Map(), // id -> player (has .ws)
    bots: new Map(), // id -> bot
    obstacles: [],
    botCounter: 0,
    spawnCounter: 0,
    createdAt: Date.now(),
    emptySince: null,
    endedAt: null,
    respawnTimers: new Set(),
  };
  room.obstacles = mapObstacles(room.map);
  rooms.set(room.code, room);
  return room;
}

function broadcast(room: Room, msg: unknown, exceptId?: string): void {
  const data = JSON.stringify(msg);
  for (const p of room.players.values()) {
    if (p.id === exceptId) continue;
    if (p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
  }
}

function send(ws: WebSocket | null | undefined, msg: unknown): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function sendError(ws: WebSocket | null | undefined, message: string): void {
  send(ws, { type: "error", message });
}

function stateMessage(room: Room) {
  return {
    type: "state",
    players: [...room.players.values()].map(publicEntry),
    bots: [...room.bots.values()].map(publicEntry),
    timeLeft: Math.max(0, Math.ceil(room.timeLeft)),
    scores: { ...room.scores },
  };
}

function allEntities(room: Room): Entity[] {
  return [...room.players.values(), ...room.bots.values()];
}

function findEntity(room: Room, id: unknown): Entity | null {
  if (!id || typeof id !== "string") return null;
  return room.players.get(id) || room.bots.get(id) || null;
}

// --- Bots ------------------------------------------------------------------
function botNameFor(room: Room, team: string): string {
  const list = team === "FR" ? FR_BOT_NAMES : CT_BOT_NAMES;
  const used = new Set(allEntities(room).map((e) => e.name));
  for (const n of list) if (!used.has(n)) return n;
  // More bots needed than names in the list (e.g. 8 bots on a team with
  // no humans): fall back to a numbered suffix.
  let i = 2;
  while (used.has(`${list[0]}-${i}`)) i++;
  return `${list[0]}-${i}`;
}

function addBot(room: Room, team: string): Entity {
  room.botCounter += 1;
  const id = `bot-${room.botCounter}`;
  const bot: Entity = {
    id,
    name: botNameFor(room, team),
    team,
    character: team === "FR"
      ? FR_CHARACTERS[room.botCounter % FR_CHARACTERS.length]
      : CT_CHARACTERS[room.botCounter % CT_CHARACTERS.length],
    weapon: room.botCounter % 2 === 0 ? "ak47" : "k5",
    x: 0, z: 0, yaw: 0, hp: PLAYER_HP, alive: true,
    kills: 0, deaths: 0, isBot: true,
    spawnIndex: room.spawnCounter++,
    waypoint: null,
    respawnAt: 0,
    nextShotAt: 0, // per-bot shot cooldown (ms epoch); see botTick
  };
  const s = spawnFor(room, bot);
  bot.x = s.x;
  bot.z = s.z;
  bot.yaw = room.mode === "ffa" ? yawToFace(-bot.x, -bot.z)
    : yawToFace((team === "FR" ? -26 : 26) - bot.x, 0 - bot.z);
  room.bots.set(id, bot);
  return bot;
}

function countTeam(room: Room, team: string): number {
  return allEntities(room).filter((e) => e.team === team).length;
}

function fillBots(room: Room): void {
  if (room.mode === "ffa") {
    while (allEntities(room).length < TEAM_SIZE) addBot(room, "FFA");
  } else {
    while (countTeam(room, "CT") < TEAM_SIZE) addBot(room, "CT");
    while (countTeam(room, "FR") < TEAM_SIZE) addBot(room, "FR");
  }
}

function removeBot(room: Room, id: string): void {
  room.bots.delete(id);
}

// --- Match flow ------------------------------------------------------------
function startMatch(room: Room): void {
  room.state = "playing";
  room.timeLeft = MATCH_LENGTH;
  room.scores = { CT: 0, FR: 0 };
  room.endedAt = null;
  for (const e of allEntities(room)) {
    e.kills = 0;
    e.deaths = 0;
    e.hp = PLAYER_HP;
    e.alive = true;
    const s = spawnFor(room, e);
    e.x = s.x;
    e.z = s.z;
    e.yaw = room.mode === "ffa"
      ? yawToFace(-e.x, -e.z)
      : yawToFace((e.team === "FR" ? -26 : 26) - e.x, 0 - e.z);
    if (e.isBot) e.waypoint = null;
  }
  fillBots(room);
  broadcast(room, { type: "matchStarted", timeLeft: MATCH_LENGTH });
  broadcast(room, stateMessage(room));
  console.log(
    `[${room.code}] match started (${room.mode}, ${room.map}) ` +
      `${room.players.size} humans, ${room.bots.size} bots`,
  );
}

function endMatch(room: Room, winner: string): void {
  if (room.state !== "playing") return;
  room.state = "ended";
  room.endedAt = Date.now();
  room.timeLeft = 0;
  broadcast(room, { type: "matchEnded", winner, scores: { ...room.scores } });
  broadcast(room, stateMessage(room));
  console.log(
    `[${room.code}] match ended, winner=${winner} ` +
      `scores=${JSON.stringify(room.scores)}`,
  );
}

function computeWinner(room: Room): string {
  if (room.mode === "ffa") {
    let best: Entity | null = null;
    for (const e of allEntities(room)) {
      if (!best || e.kills > best.kills) best = e;
    }
    if (!best || best.kills === 0) return "draw";
    const tied = allEntities(room).filter((e) => e.kills === best!.kills).length > 1;
    return tied ? "draw" : best.name;
  }
  if (room.scores.CT === room.scores.FR) return "draw";
  return room.scores.CT > room.scores.FR ? "CT" : "FR";
}

function checkMatchEnd(room: Room): void {
  if (room.state !== "playing") return;
  if (room.timeLeft <= 0) {
    endMatch(room, computeWinner(room));
    return;
  }
  if (room.mode === "tdm") {
    if (room.scores.CT >= TDM_TARGET || room.scores.FR >= TDM_TARGET) {
      endMatch(room, computeWinner(room));
    }
  } else {
    for (const e of allEntities(room)) {
      if (e.kills >= FFA_TARGET) {
        endMatch(room, computeWinner(room));
        return;
      }
    }
  }
}

function scheduleRespawn(room: Room, entity: Entity): void {
  const timer = setTimeout(() => {
    room.respawnTimers.delete(timer);
    if (room.state !== "playing") return;
    if (entity.isBot && !room.bots.has(entity.id)) return;
    if (!entity.isBot && !room.players.has(entity.id)) return;
    entity.hp = PLAYER_HP;
    entity.alive = true;
    const s = spawnFor(room, entity);
    entity.x = s.x;
    entity.z = s.z;
    entity.yaw = room.mode === "ffa"
      ? yawToFace(-entity.x, -entity.z)
      : yawToFace((entity.team === "FR" ? -26 : 26) - entity.x, 0 - entity.z);
    if (entity.isBot) entity.waypoint = null;
    broadcast(room, { type: "respawned", id: entity.id, x: entity.x, z: entity.z });
    broadcast(room, stateMessage(room));
  }, RESPAWN_DELAY_MS);
  room.respawnTimers.add(timer);
}

// --- Shooting ---------------------------------------------------------------
function weaponDamage(weaponId: string): number {
  const w = WEAPONS[weaponId] || WEAPONS.k5;
  return w.pellets ? w.dmg * w.pellets : w.dmg; // m1887: 12 x 8 pellets
}

function applyHit(room: Room, shooter: Entity, target: Entity, damage: number): void {
  target.hp -= damage;
  let killed = false;
  if (target.hp <= 0) {
    target.hp = 0;
    target.alive = false;
    killed = true;
    shooter.kills += 1;
    target.deaths += 1;
    if (room.mode === "tdm" && shooter.team !== "FFA") {
      if (shooter.team === "CT") room.scores.CT += 1;
      else if (shooter.team === "FR") room.scores.FR += 1;
    }
    broadcast(room, {
      type: "killfeed", killer: shooter.name, victim: target.name,
      weapon: shooter.weapon, headshot: false,
    });
    scheduleRespawn(room, target);
  }
  broadcast(room, {
    type: "hit", shooterId: shooter.id, targetId: target.id,
    targetIsBot: !!target.isBot, damage, hpLeft: target.hp, killed,
  });
  if (killed) checkMatchEnd(room);
}

function handleShoot(room: Room, shooter: Entity, targetId: string | null): void {
  if (!shooter || !shooter.alive) return; // shooter must be alive
  if (!targetId) return; // miss shot: nothing to validate/broadcast
  const target = findEntity(room, targetId);
  if (!target || !target.alive) return; // dead/invalid target: ignore
  if (target.id === shooter.id) return;
  const weapon = WEAPONS[shooter.weapon] || WEAPONS.k5;
  const dx = target.x - shooter.x, dz = target.z - shooter.z;
  const dist = Math.hypot(dx, dz);
  if (dist > weapon.range) return;
  if (room.mode === "tdm" && target.team === shooter.team) return; // no friendly fire
  const fwd = forwardOf(shooter.yaw);
  const dot = dist > 1e-9 ? (fwd.x * dx + fwd.z * dz) / dist : 1;
  if (dot <= 0.35) return; // shooter must roughly face the target
  applyHit(room, shooter, target, weaponDamage(shooter.weapon));
}

// --- Bot AI (10/s tick) ------------------------------------------------------
function botTick(room: Room, dt: number, now: number): void {
  for (const bot of [...room.bots.values()]) {
    if (!bot.alive) continue;
    const enemies = allEntities(room).filter((e) =>
      e.alive && e.id !== bot.id &&
      (room.mode === "ffa" || e.team !== bot.team));
    if (enemies.length === 0) continue;
    let nearest: Entity | null = null, nearestDist = Infinity;
    for (const e of enemies) {
      const d = Math.hypot(e.x - bot.x, e.z - bot.z);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = e;
      }
    }
    if (!nearest) continue;
    const weapon = WEAPONS[bot.weapon] || WEAPONS.k5;
    const dx = nearest.x - bot.x, dz = nearest.z - bot.z;
    bot.yaw = yawToFace(dx, dz);
    if (nearestDist > 1) {
      // Move toward nearest enemy at 4 m/s, with obstacle push-out.
      const step = 4 * dt;
      const mx = bot.x + (dx / nearestDist) * step;
      const mz = bot.z + (dz / nearestDist) * step;
      const pos = clampMove(mx, mz, room.obstacles);
      bot.x = pos.x;
      bot.z = pos.z;
    }
    if (nearestDist < weapon.range) {
      const fwd = forwardOf(bot.yaw);
      const dot = nearestDist > 1e-9
        ? (fwd.x * dx + fwd.z * dz) / nearestDist
        : 1;
      // One shot attempt per cooldown (0.7–1.4s), 0.35 hit chance per shot.
      // Without this, a bot rolls 0.35 every 100ms tick and a group of bots
      // focus-firing melts a 100 HP player in ~1–2 ticks.
      if (dot > 0.6 && now >= bot.nextShotAt) {
        bot.nextShotAt = now + 700 + Math.random() * 700;
        if (Math.random() < 0.35) {
          applyHit(room, bot, nearest, weaponDamage(bot.weapon));
          if (room.state !== "playing") return;
        }
      }
    }
  }
  // Wander: bots with no living enemy get a random waypoint (handled by
  // moving toward it below). Enemies always exist while playing in practice,
  // but keep the branch for completeness.
  for (const bot of [...room.bots.values()]) {
    if (!bot.alive) continue;
    const enemies = allEntities(room).filter((e) =>
      e.alive && e.id !== bot.id &&
      (room.mode === "ffa" || e.team !== bot.team));
    if (enemies.length !== 0) continue;
    if (
      !bot.waypoint ||
      Math.hypot(bot.waypoint.x - bot.x, bot.waypoint.z - bot.z) < 1
    ) {
      bot.waypoint = {
        x: -28 + Math.random() * 56,
        z: -28 + Math.random() * 56,
      };
    }
    const dx = bot.waypoint.x - bot.x, dz = bot.waypoint.z - bot.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 0.5) {
      bot.yaw = yawToFace(dx, dz);
      const step = 4 * dt;
      const pos = clampMove(
        bot.x + (dx / dist) * step,
        bot.z + (dz / dist) * step,
        room.obstacles,
      );
      bot.x = pos.x;
      bot.z = pos.z;
    }
  }
}

// --- Room membership --------------------------------------------------------
function removePlayerFromRoom(room: Room, playerId: string, reason?: string): void {
  const player = room.players.get(playerId);
  if (!player) return;
  room.players.delete(playerId);
  broadcast(room, { type: "playerLeft", id: playerId });
  console.log(`[${room.code}] player left: ${player.name} (${playerId}) ${reason || ""}`);
  if (room.players.size === 0) {
    room.emptySince = Date.now();
  } else if (room.hostId === playerId) {
    // Reassign host to the first remaining human.
    room.hostId = [...room.players.keys()][0];
    broadcast(room, stateMessage(room));
  }
  if (room.state === "playing") fillBots(room);
}

function deleteRoom(room: Room): void {
  for (const t of room.respawnTimers) clearTimeout(t);
  room.respawnTimers.clear();
  rooms.delete(room.code);
  console.log(`[${room.code}] room deleted`);
}

// ---------------------------------------------------------------------------
// WebSocket connection handling (native Deno WebSocket)
// ---------------------------------------------------------------------------
function attachConnection(socket: WebSocket): void {
  let playerId: string | null = null;
  let roomCode: string | null = null;

  socket.onmessage = (event: MessageEvent) => {
    let msg: Record<string, any>;
    try {
      const text = typeof event.data === "string" ? event.data : "";
      msg = JSON.parse(text);
    } catch {
      sendError(socket, "Invalid JSON");
      return;
    }
    if (!msg || typeof msg.type !== "string") {
      sendError(socket, "Missing message type");
      return;
    }

    const room = roomCode ? rooms.get(roomCode) ?? null : null;
    const me = room && playerId ? room.players.get(playerId) ?? null : null;

    switch (msg.type) {
      case "createRoom": {
        if (room) {
          sendError(socket, "Already in a room");
          break;
        }
        const r = createRoom(msg.map, msg.mode);
        const team = r.mode === "ffa"
          ? (typeof msg.team === "string" && msg.team ? msg.team : "FFA")
          : (msg.team === "FR" ? "FR" : "CT");
        const player: Entity = {
          id: newId("p-"), ws: socket,
          name: String(msg.name || "Player").slice(0, 32) || "Player",
          team, character: msg.character || defaultCharacter(team),
          weapon: validWeapon(msg.weapon),
          x: 0, z: 0, yaw: 0, hp: PLAYER_HP, alive: true,
          kills: 0, deaths: 0, isBot: false,
          spawnIndex: r.spawnCounter++,
          waypoint: null, respawnAt: 0, nextShotAt: 0,
        };
        const s = spawnFor(r, player);
        player.x = s.x;
        player.z = s.z;
        r.hostId = player.id;
        r.players.set(player.id, player);
        playerId = player.id;
        roomCode = r.code;
        send(socket, { type: "roomCreated", code: r.code, room: publicRoom(r) });
        console.log(`[${r.code}] room created by ${player.name} (${r.mode}, ${r.map})`);
        break;
      }

      case "joinRoom": {
        if (room) {
          sendError(socket, "Already in a room");
          break;
        }
        const r = typeof msg.code === "string"
          ? rooms.get(msg.code.toUpperCase()) ?? null
          : null;
        if (!r) {
          sendError(socket, "Room not found");
          break;
        }
        if (r.state === "ended") {
          sendError(socket, "Match has ended");
          break;
        }
        const team = r.mode === "ffa"
          ? (typeof msg.team === "string" && msg.team ? msg.team : "FFA")
          : (msg.team === "FR" ? "FR" : "CT");
        const player: Entity = {
          id: newId("p-"), ws: socket,
          name: String(msg.name || "Player").slice(0, 32) || "Player",
          team, character: msg.character || defaultCharacter(team),
          weapon: validWeapon(msg.weapon),
          x: 0, z: 0, yaw: 0, hp: PLAYER_HP, alive: true,
          kills: 0, deaths: 0, isBot: false,
          spawnIndex: r.spawnCounter++,
          waypoint: null, respawnAt: 0, nextShotAt: 0,
        };
        const s = spawnFor(r, player);
        player.x = s.x;
        player.z = s.z;
        // Late join during a live match: spawn alive at team spawn.
        r.players.set(player.id, player);
        playerId = player.id;
        roomCode = r.code;
        send(socket, { type: "roomJoined", room: publicRoom(r) });
        broadcast(r, { type: "playerJoined", player: publicEntry(player) }, player.id);
        if (r.state === "playing") fillBots(r);
        console.log(`[${r.code}] player joined: ${player.name} (${player.id})`);
        break;
      }

      case "leaveRoom": {
        if (!room || !me) {
          sendError(socket, "Not in a room");
          break;
        }
        removePlayerFromRoom(room, me.id, "leave");
        playerId = null;
        roomCode = null;
        break;
      }

      case "startMatch": {
        if (!room || !me) {
          sendError(socket, "Not in a room");
          break;
        }
        if (room.hostId !== me.id) {
          sendError(socket, "Only the host can start the match");
          break;
        }
        if (room.state !== "lobby") {
          sendError(socket, "Match already started");
          break;
        }
        if (room.players.size < 1) {
          sendError(socket, "Need at least 1 player");
          break;
        }
        startMatch(room);
        break;
      }

      case "move": {
        if (!room || !me) break;
        if (!me.alive) break;
        const x = Number(msg.x), z = Number(msg.z), yaw = Number(msg.yaw);
        if (!Number.isFinite(x) || !Number.isFinite(z)) break;
        const pos = clampMove(x, z, room.obstacles);
        me.x = pos.x;
        me.z = pos.z;
        if (Number.isFinite(yaw)) me.yaw = yaw;
        break;
      }

      case "shoot": {
        if (!room || !me) break;
        if (room.state !== "playing") break;
        handleShoot(room, me, msg.targetId || null);
        break;
      }

      case "respawn": {
        if (!room || !me) break;
        if (me.alive) break;
        me.hp = PLAYER_HP;
        me.alive = true;
        const s = spawnFor(room, me);
        me.x = s.x;
        me.z = s.z;
        me.yaw = room.mode === "ffa"
          ? yawToFace(-me.x, -me.z)
          : yawToFace((me.team === "FR" ? -26 : 26) - me.x, 0 - me.z);
        broadcast(room, { type: "respawned", id: me.id, x: me.x, z: me.z });
        break;
      }

      case "updateWeapon": {
        if (!room || !me) break;
        me.weapon = validWeapon(msg.weapon);
        break;
      }

      case "updateCharacter": {
        if (!room || !me) break;
        if (typeof msg.character === "string" && msg.character) {
          me.character = msg.character.slice(0, 32);
        }
        break;
      }

      case "updateTeam": {
        if (!room || !me) break;
        if (room.state !== "lobby") {
          sendError(socket, "Cannot change team during a match");
          break;
        }
        if (room.mode === "tdm" && (msg.team === "CT" || msg.team === "FR")) {
          me.team = msg.team;
        } else if (room.mode === "ffa" && typeof msg.team === "string" && msg.team) {
          me.team = msg.team;
        }
        break;
      }

      case "chat": {
        if (!room || !me) break;
        const text = String(msg.text || "").slice(0, 200);
        if (!text) break;
        broadcast(room, {
          type: "chat", name: me.name, team: me.team, text, time: Date.now(),
        });
        break;
      }

      case "voiceSignal": {
        if (!room || !me) break;
        if (msg.signal === undefined) break;
        const out = { type: "voiceSignal", from: me.id, signal: msg.signal };
        if (msg.to === "*") {
          broadcast(room, out, me.id);
        } else if (typeof msg.to === "string") {
          const target = room.players.get(msg.to);
          if (target && target.ws && target.ws.readyState === WebSocket.OPEN) {
            target.ws.send(JSON.stringify(out));
          }
        }
        break;
      }

      default:
        sendError(socket, `Unknown message type: ${msg.type}`);
    }
  };

  socket.onclose = () => {
    if (roomCode && playerId) {
      const room = rooms.get(roomCode);
      if (room) removePlayerFromRoom(room, playerId, "disconnect");
    }
  };

  socket.onerror = (err: Event | ErrorEvent) => {
    console.error("ws error:", (err as ErrorEvent).message ?? err);
  };
}

// ---------------------------------------------------------------------------
// HTTP static server (./public) + WebSocket upgrade on the same port
// ---------------------------------------------------------------------------
const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".map": "application/json",
};

const PUBLIC_BASE = decodeURIComponent(new URL("./public/", import.meta.url).pathname);

function resolvePublicPath(urlPath: string): string | null {
  const parts = urlPath.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.includes("..")) return null;
  return PUBLIC_BASE + parts.join("/");
}

async function handleRequest(req: Request): Promise<Response> {
  // WebSocket upgrade on any path (matches the Node ws server behaviour).
  if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
    try {
      const { socket, response } = Deno.upgradeWebSocket(req);
      attachConnection(socket);
      return response;
    } catch {
      return new Response("WebSocket upgrade failed", { status: 400 });
    }
  }

  // Static files.
  try {
    let urlPath = decodeURIComponent(new URL(req.url).pathname);
    if (urlPath === "/") urlPath = "/index.html";
    const filePath = resolvePublicPath(urlPath);
    if (!filePath) return new Response("Forbidden", { status: 403 });
    const dot = filePath.lastIndexOf(".");
    const ext = dot >= 0 ? filePath.slice(dot) : "";
    try {
      const data = await Deno.readFile(filePath);
      return new Response(data, {
        headers: { "content-type": MIME[ext] || "application/octet-stream" },
      });
    } catch {
      if (urlPath === "/index.html") {
        return new Response(
          "<h1>PB FPS Online</h1><p>Server running. Client not deployed yet.</p>",
          { headers: { "content-type": "text/html" } },
        );
      }
      return new Response("Not found", { status: 404 });
    }
  } catch {
    return new Response("Server error", { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Global tick: 10/s. Bots + timer while playing; lobby state at 2/s.
// ---------------------------------------------------------------------------
let tickCount = 0;
function startTick(): void {
  setInterval(() => {
    tickCount += 1;
    const now = Date.now();
    for (const room of [...rooms.values()]) {
      if (room.state === "playing") {
        room.timeLeft -= 0.1;
        botTick(room, 0.1, now);
        if (room.state === "playing") fillBots(room); // keep teams topped up
        checkMatchEnd(room);
        broadcast(room, stateMessage(room));
      } else if (room.state === "lobby") {
        if (tickCount % 5 === 0) broadcast(room, stateMessage(room));
      }
      // Cleanup: empty rooms after 5 min with no humans; ended rooms
      // 60s after ending if empty.
      if (room.players.size === 0) {
        if (room.emptySince === null) room.emptySince = now;
        const emptyFor = now - room.emptySince;
        if (room.state === "ended" && room.endedAt && now - room.endedAt > ENDED_ROOM_TTL_MS) {
          deleteRoom(room);
        } else if (room.state !== "ended" && emptyFor > EMPTY_ROOM_TTL_MS) {
          deleteRoom(room);
        }
      } else {
        room.emptySince = null;
      }
    }
  }, 100);
}

if (import.meta.main) {
  startTick();
  Deno.serve({ port: PORT }, handleRequest);
  console.log(`PB FPS Online server listening on port ${PORT}`);
}
