const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const os = require("os");
const path = require("path");
const fs = require("fs");
const readline = require("readline");
const net = require("net");
const crypto = require("crypto");
const { execSync, spawn } = require("child_process");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  pingTimeout: 120000,
  pingInterval: 25000
});
let PORT = parseInt(process.env.PORT, 10) || 3100;
const ADMIN_PASSWORD = process.env.ADMIN_PW || "fubar";
let cloudflaredProcess = null;

function findCloudflared() {
  try {
    const r = execSync("which cloudflared 2>/dev/null || command -v cloudflared 2>/dev/null", { stdio: ["ignore", "pipe", "ignore"], timeout: 2000 });
    const p = r.toString().trim();
    if (p) return p;
  } catch(e) {}
  try {
    execSync("cmd.exe /c where cloudflared >nul 2>nul", { stdio: ["ignore", "pipe", "ignore"], timeout: 2000 });
    return "cloudflared.exe";
  } catch(e) {}
  try {
    const p = "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe";
    execSync("cmd.exe /c if exist \"" + p + "\" echo 1", { stdio: ["ignore", "pipe", "ignore"], timeout: 2000 });
    return p;
  } catch(e) {}
  return null;
}

function startCloudflaredTunnel() {
  return new Promise((resolve, reject) => {
    const cf = findCloudflared();
    if (!cf) { reject(new Error("cloudflared no encontrado")); return; }
    log("Iniciando Cloudflare Tunnel...");
    const cfCmd = cf.includes(" ") ? "\"" + cf + "\"" : cf;
    const proc = spawn(cfCmd, ["tunnel", "--url", "http://localhost:" + PORT], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: process.platform === "win32" || cf.endsWith(".exe")
    });
    cloudflaredProcess = proc;
    const timeout = setTimeout(() => reject(new Error("Timeout esperando URL de cloudflared")), 30000);
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString();
      const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) {
        clearTimeout(timeout);
        global.publicUrl = m[0];
        log("Tunnel Cloudflare activo: " + global.publicUrl);
        resolve(global.publicUrl);
      }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("error", (err) => { clearTimeout(timeout); reject(err); });
    proc.on("exit", (code) => {
      clearTimeout(timeout);
      if (!global.publicUrl) reject(new Error("cloudflared exit code " + code));
    });
  });
}

const sessions = {};
function getSession(sid) {
  if (!sessions[sid]) sessions[sid] = { players: {}, objectives: {}, notes: [], alert: null, pois: {}, squads: {} };
  return sessions[sid];
}

// ====== AUTH SYSTEM ======
const USERS_FILE = path.join(__dirname, "users.json");

function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, "utf8")); }
  catch(e) { return {}; }
}
function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), "utf8");
}
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, "sha512").toString("hex");
  return salt + ":" + hash;
}
function verifyPassword(password, stored) {
  const parts = stored.split(":");
  if (parts.length < 2) return false;
  return crypto.pbkdf2Sync(password, parts[0], 1000, 64, "sha512").toString("hex") === parts[1];
}
function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

app.post("/api/register", express.json(), (req, res) => {
  const { callsign, password, team } = req.body;
  if (!callsign || !password) return res.status(400).json({ error: "Callsign y password requeridos" });
  if (password.length < 4) return res.status(400).json({ error: "Password debe tener al menos 4 caracteres" });
  const users = loadUsers();
  const key = callsign.toLowerCase();
  if (users[key]) return res.status(409).json({ error: "Ese callsign ya existe" });
  const token = generateToken();
  users[key] = { callsign, password: hashPassword(password), team: team || "", token, createdAt: Date.now() };
  saveUsers(users);
  log("[AUTH] Registrado: " + callsign);
  res.json({ ok: true, callsign, token, team: users[key].team });
});

app.post("/api/login", express.json(), (req, res) => {
  const { callsign, password } = req.body;
  if (!callsign || !password) return res.status(400).json({ error: "Callsign y password requeridos" });
  const users = loadUsers();
  const key = callsign.toLowerCase();
  const user = users[key];
  if (!user || !verifyPassword(password, user.password)) return res.status(401).json({ error: "Credenciales inválidas" });
  const token = generateToken();
  user.token = token;
  saveUsers(users);
  log("[AUTH] Login: " + user.callsign);
  res.json({ ok: true, callsign: user.callsign, token, team: user.team || "" });
});

app.get("/api/me", (req, res) => {
  const token = req.headers.authorization || req.query.token;
  if (!token) return res.status(401).json({ error: "Token requerido" });
  const users = loadUsers();
  for (const key in users) {
    if (users[key].token === token) {
      return res.json({ ok: true, callsign: users[key].callsign, team: users[key].team || "" });
    }
  }
  res.status(401).json({ error: "Token inválido" });
});

// ====== MULTIVIEW ======
const multiviewSockets = new Set();

app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
app.get("/api/server-info", (req, res) => {
  res.json({ ip: getLocalIP(), winHostname: getWinHostname(), port: PORT, publicUrl: global.publicUrl || null });
});

// Management API endpoints
app.get("/api/status", (req, res) => {
  const data = { sessions: {} };
  Object.keys(sessions).forEach(sid => {
    const sess = sessions[sid];
    data.sessions[sid] = {
      players: Object.values(sess.players).map(p => ({
        name: p.name, section: p.section, replica: p.replica,
        online: p.online, isAdmin: !!p.isAdmin, bodycam: !!p.bodycam,
        hasGPS: !!p.lat, heading: p.heading || 0,
        squad: p.squad, lastSeen: p.lastSeen
      })),
      squads: Object.values(sess.squads).map(sq => ({
        id: sq.id, name: sq.name, members: sq.members.length
      })),
      pois: Object.values(sess.pois).map(p => ({ name: p.name, type: p.type, lat: p.lat, lon: p.lon })),
      objectives: sess.objectives
    };
  });
  res.json(data);
});

app.post("/api/broadcast", express.json(), (req, res) => {
  const { password, message } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "Admin password incorrecta" });
  if (!message) return res.status(400).json({ error: "Mensaje requerido" });
  Object.keys(sessions).forEach(sid => {
    io.to(sid).emit("alert-broadcast", { message, type: "admin" });
  });
  log("[API] Broadcast: " + message);
  res.json({ ok: true });
});

io.on("connection", (socket) => {
  let mySession = null, myPlayerId = null;
  log("[+] Device connected: " + socket.handshake.address);

  socket.emit("server-info", {
    localIP: getLocalIP(),
    winHostname: getWinHostname(),
    port: PORT,
    publicUrl: global.publicUrl || null
  });

  socket.on("ping-background", () => {
    // Silent keepalive - no broadcast, solo mantiene la conexion viva
  });

  socket.on("join-session", ({ sessionId, player, adminPassword }) => {
    mySession = sessionId;
    myPlayerId = player.id;
    socket.join(sessionId);
    const sess = getSession(sessionId);
    sess.players[player.id] = Object.assign({}, player, { socketId: socket.id, online: true });
    if (adminPassword === ADMIN_PASSWORD) {
      sess.players[player.id].isAdmin = true;
    }
    socket.emit("sync-state", sess);
    io.to(sessionId).emit("player-joined", sess.players[player.id]);
    io.to(sessionId).emit("players-update", sess.players);
    log("[" + sessionId + "] Player: " + player.name + " (" + player.section + ")");
  });

  socket.on("update-position", ({ sessionId, playerId, lat, lon, accuracy, heading, x, y }) => {
    const sess = getSession(sessionId);
    if (sess.players[playerId]) {
      Object.assign(sess.players[playerId], { lat, lon, accuracy, heading, x, y, lastSeen: Date.now() });
      socket.to(sessionId).emit("player-moved", { playerId, lat, lon, accuracy, heading, x, y });
    }
  });

  socket.on("update-heading", ({ sessionId, playerId, heading }) => {
    const sess = getSession(sessionId);
    if (sess.players[playerId] && heading != null) {
      sess.players[playerId].heading = heading;
      socket.to(sessionId).emit("player-heading", { playerId, heading });
    }
  });

  socket.on("add-objective", ({ sessionId, objective }) => {
    const sess = getSession(sessionId);
    sess.objectives[objective.id] = Object.assign({}, objective, { createdAt: Date.now() });
    io.to(sessionId).emit("objectives-update", sess.objectives);
  });

  socket.on("complete-objective", ({ sessionId, objectiveId, completedBy }) => {
    const sess = getSession(sessionId);
    if (sess.objectives[objectiveId]) {
      Object.assign(sess.objectives[objectiveId], { done: true, completedBy, completedAt: Date.now() });
      io.to(sessionId).emit("objectives-update", sess.objectives);
      io.to(sessionId).emit("alert-broadcast", {
        message: "OBJETIVO CUMPLIDO: " + sess.objectives[objectiveId].name,
        type: "success"
      });
    }
  });

  socket.on("clear-done", ({ sessionId }) => {
    const sess = getSession(sessionId);
    Object.keys(sess.objectives).forEach(id => {
      if (sess.objectives[id].done) delete sess.objectives[id];
    });
    io.to(sessionId).emit("objectives-update", sess.objectives);
  });

  socket.on("send-note", ({ sessionId, note }) => {
    const sess = getSession(sessionId);
    const full = Object.assign({}, note, { id: Date.now().toString(36), createdAt: Date.now() });
    sess.notes.push(full);
    if (sess.notes.length > 100) sess.notes.shift();
    io.to(sessionId).emit("notes-update", sess.notes);
  });

  socket.on("broadcast-alert", ({ sessionId, message, type }) => {
    io.to(sessionId).emit("alert-broadcast", { message, type });
  });

  socket.on("disconnect", () => {
    multiviewSockets.delete(socket.id);
    if (mySession && myPlayerId) {
      const sess = getSession(mySession);
      if (sess.players[myPlayerId]) {
        const name = sess.players[myPlayerId].name;
        delete sess.players[myPlayerId];
        io.to(mySession).emit("players-update", sess.players);
        io.to(mySession).emit("alert-broadcast", {
          message: name + " DESCONECTADO",
          type: "warning"
        });
        log("[-] " + name + " disconnected from " + mySession);
      }
    }
  });
  
  socket.on("add-poi", ({ sessionId, poi }) => {
    const sess = getSession(sessionId);
    sess.pois[poi.id] = poi;
    io.to(sessionId).emit("pois-update", sess.pois);
    io.to(sessionId).emit("alert-broadcast", {
      message: "POI: " + poi.name + " (" + poi.type.toUpperCase() + ")",
      type: "info"
    });
    log("[" + sessionId + "] POI added: " + poi.name);
  });
  
  socket.on("delete-poi", ({ sessionId, poiId }) => {
    const sess = getSession(sessionId);
    if (sess.pois[poiId]) {
      const name = sess.pois[poiId].name;
      delete sess.pois[poiId];
      io.to(sessionId).emit("pois-update", sess.pois);
      io.to(sessionId).emit("alert-broadcast", {
        message: "POI eliminado: " + name,
        type: "warning"
      });
    }
  });

  // Squad management events
  socket.on("create-squad", ({ sessionId, name }) => {
    const sess = getSession(sessionId);
    if (!sess.players[myPlayerId] || !sess.players[myPlayerId].isAdmin) return;
    const id = "SQ-" + Date.now().toString(36).toUpperCase();
    sess.squads[id] = { id, name, members: [] };
    io.to(sessionId).emit("squads-update", sess.squads);
    io.to(sessionId).emit("alert-broadcast", {
      message: "ESCUADRA CREADA: " + name,
      type: "success"
    });
  });

  socket.on("delete-squad", ({ sessionId, squadId }) => {
    const sess = getSession(sessionId);
    if (!sess.players[myPlayerId] || !sess.players[myPlayerId].isAdmin) return;
    if (sess.squads[squadId]) {
      const members = sess.squads[squadId].members || [];
      members.forEach(pid => {
        if (sess.players[pid]) sess.players[pid].squad = null;
      });
      delete sess.squads[squadId];
      io.to(sessionId).emit("squads-update", sess.squads);
      io.to(sessionId).emit("players-update", sess.players);
    }
  });

  socket.on("assign-to-squad", ({ sessionId, playerId, squadId }) => {
    const sess = getSession(sessionId);
    if (!sess.players[myPlayerId] || !sess.players[myPlayerId].isAdmin) return;
    Object.keys(sess.squads).forEach(sid => {
      const idx = sess.squads[sid].members.indexOf(playerId);
      if (idx !== -1) sess.squads[sid].members.splice(idx, 1);
    });
    if (sess.squads[squadId] && sess.players[playerId]) {
      sess.squads[squadId].members.push(playerId);
      sess.players[playerId].squad = squadId;
    }
    io.to(sessionId).emit("squads-update", sess.squads);
    io.to(sessionId).emit("players-update", sess.players);
  });

  socket.on("remove-from-squad", ({ sessionId, playerId }) => {
    const sess = getSession(sessionId);
    if (!sess.players[myPlayerId] || !sess.players[myPlayerId].isAdmin) return;
    Object.keys(sess.squads).forEach(sid => {
      const idx = sess.squads[sid].members.indexOf(playerId);
      if (idx !== -1) sess.squads[sid].members.splice(idx, 1);
    });
    if (sess.players[playerId]) sess.players[playerId].squad = null;
    io.to(sessionId).emit("squads-update", sess.squads);
    io.to(sessionId).emit("players-update", sess.players);
  });

  // Bodycam events
  socket.on("bodycam-start", ({ sessionId }) => {
    const sess = getSession(sessionId);
    if (sess.players[myPlayerId]) {
      sess.players[myPlayerId].bodycam = true;
      io.to(sessionId).emit("players-update", sess.players);
      log("[" + sessionId + "] Bodycam ON: " + sess.players[myPlayerId].name);
    }
  });

  socket.on("bodycam-stop", ({ sessionId }) => {
    const sess = getSession(sessionId);
    if (sess.players[myPlayerId]) {
      sess.players[myPlayerId].bodycam = false;
      io.to(sessionId).emit("players-update", sess.players);
      log("[" + sessionId + "] Bodycam OFF: " + sess.players[myPlayerId].name);
    }
  });

  const frameThrottle = {};
  socket.on("bodycam-frame", ({ sessionId, image }) => {
    const now = Date.now();
    const last = frameThrottle[myPlayerId] || 0;
    if (now - last < 80) return;
    frameThrottle[myPlayerId] = now;
    socket.to(sessionId).emit("bodycam-frame", { playerId: myPlayerId, image });
    multiviewSockets.forEach(sid => {
      const s = io.sockets.sockets.get(sid);
      if (s) s.emit("bodycam-multiview-frame", { playerId: myPlayerId, image });
    });
  });

  socket.on("join-multiview", () => {
    multiviewSockets.add(socket.id);
    log("[MULTIVIEW] Admin activo: " + (mySession ? sessions[mySession]?.players[myPlayerId]?.name || socket.id : socket.id));
  });

  socket.on("leave-multiview", () => {
    multiviewSockets.delete(socket.id);
  });
});

function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const iface of nets[name]) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return "127.0.0.1";
}

function getWinHostname() {
  return "VectorX";
}

function log(msg) {
  const t = new Date().toLocaleTimeString("es-PA");
  console.log("[" + t + "] " + msg);
}

function printBanner(localIP, publicUrl) {
  const winHost = getWinHostname();
  console.log("");
  console.log("+----------------------------------------------------------+");
  console.log("|              ▣ VectorX  SERVER  ACTIVO                    |");
  console.log("+----------------------------------------------------------+");
  console.log("|  Local  : http://localhost:" + PORT + "                          |");
  console.log("|  Red    : http://" + localIP + ":" + PORT + "                    |");
  console.log("|  PC     : http://" + winHost + ":" + PORT + "                    |");
  if (publicUrl) {
    console.log("+----------------------------------------------------------+");
    console.log("|  INTERNET: " + publicUrl.padEnd(48) + "|");
    console.log("|  -> Accesible desde CUALQUIER red o celular              |");
  }
  console.log("+----------------------------------------------------------+");
  console.log("|  Presiona Ctrl+C para detener el servidor                 |");
  console.log("+----------------------------------------------------------+");
  console.log("");
}

function findFreePort(startPort) {
  return new Promise(resolve => {
    const tryPort = (p) => {
      if (p > startPort + 20) { resolve(-1); return; }
      const tester = net.createServer()
        .once("error", () => tryPort(p + 1))
        .once("listening", () => { tester.close(); resolve(p); })
        .listen(p, "0.0.0.0");
    };
    tryPort(startPort);
  });
}

function killPort(port) {
  try {
    log("Puerto " + port + " ocupado. Intentando liberar...");
    let result = "";
    if (process.platform === "win32") {
      try {
        result = execSync(
          "netstat -ano | findstr :" + port + " | findstr LISTENING",
          { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
        ).trim();
      } catch (e) { result = ""; }
    } else {
      try {
        result = execSync("lsof -ti tcp:" + port + " 2>/dev/null", { encoding: "utf8" }).trim();
      } catch (_) { result = ""; }
    }
    if (!result) return false;
    const pids = new Set();
    if (process.platform === "win32") {
      result.split("\n").filter(Boolean).forEach(line => {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && pid !== "0") pids.add(pid);
      });
    } else {
      result.split("\n").forEach(pid => { if (pid.trim()) pids.add(pid.trim()); });
    }
    pids.forEach(pid => {
      try {
        const cmd = process.platform === "win32"
          ? "taskkill /PID " + pid + " /F"
          : "kill -9 " + pid;
        execSync(cmd, { stdio: "pipe" });
        log("Proceso PID " + pid + " terminado.");
      } catch (e) {
        log("No se pudo terminar PID " + pid);
      }
    });
    return pids.size > 0;
  } catch (e) {
    return false;
  }
}

function askMenu(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

async function main() {
  const localIP = getLocalIP();
  console.log("");
console.log("+------------------------------------------------------+");
console.log("|          VectorX - MODO DE ACCESO                     |");
console.log("+------------------------------------------------------+");
console.log("|  [1] Solo red local (WiFi)                            |");
console.log("|  [2] Cloudflare Tunnel (gratis, no necesita cuenta)    |");

  console.log("+------------------------------------------------------+");
  console.log("");

  let choice = await askMenu("  Elige una opcion (1 o 2): ");

  // Auto-find available port
  const found = await findFreePort(PORT);
  if (found === -1) {
    console.error("[ERROR] No se encontro puerto libre después de 20 intentos.");
    process.exit(1);
  }
  if (found !== PORT) log("Puerto " + PORT + " ocupado, usando " + found);
  PORT = found;

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, "0.0.0.0", () => {
      log("Servidor HTTP activo en puerto " + PORT);
      log("IPs disponibles:");
      const nets = os.networkInterfaces();
      for (const name of Object.keys(nets)) {
        for (const iface of nets[name]) {
          if (iface.family === "IPv4" && !iface.internal) {
            log("  -> http://" + iface.address + ":" + PORT);
          }
        }
      }
      log("  -> http://localhost:" + PORT);
      const winHost = getWinHostname();
      log("  -> http://" + winHost + ":" + PORT + " (nombre del PC - Windows)");
      resolve();
    });
  });

  if (choice === "2") {
    try {
      await startCloudflaredTunnel();
      printBanner(localIP, global.publicUrl);
      io.emit("public-url-updated", { url: global.publicUrl });
    } catch (cfErr) {
      console.error("[ERROR Cloudflare]: " + cfErr.message);
      log("Continuando en modo red local.");
      printBanner(localIP, null);
    }
    startCLI();
    return;
  }

  printBanner(localIP, null);
  startCLI();
}

function startCLI() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "", terminal: true });
  log("CLI activo. Escribe ayuda para ver comandos.");

  const cmds = {
    jugadores: () => {
      let total = 0;
      Object.keys(sessions).forEach(sid => {
        const ps = Object.values(sessions[sid].players);
        if (!ps.length) return;
        console.log("\n[" + sid + "]");
        ps.forEach(p => {
          const flags = (p.lat ? "G" : "-") + (p.bodycam ? "C" : "-") + (p.isAdmin ? "A" : "-");
          console.log("  " + p.name.padEnd(16) + " " + p.section.padEnd(12) + " [" + flags + "] " + (p.replica || "?"));
          total++;
        });
      });
      console.log("\nTotal: " + total + " jugadores\n");
    },
    sessions: () => {
      const sids = Object.keys(sessions);
      if (!sids.length) { console.log("  No hay sesiones activas.\n"); return; }
      sids.forEach(sid => {
        const s = sessions[sid];
        console.log("  " + sid + " | " + Object.keys(s.players).length + " jug | " + Object.keys(s.pois).length + " POI | " + Object.keys(s.squads).length + " esc");
      });
      console.log();
    },
    broadcast: (msg) => {
      if (!msg) { console.log("  Uso: broadcast <mensaje>\n"); return; }
      Object.keys(sessions).forEach(sid => io.to(sid).emit("alert-broadcast", { message: msg, type: "admin" }));
      log("Broadcast: " + msg);
    },
    pois: () => {
      let total = 0;
      Object.keys(sessions).forEach(sid => {
        const ps = Object.values(sessions[sid].pois);
        if (!ps.length) return;
        console.log("\n[" + sid + "]");
        ps.forEach(p => { console.log("  " + p.name + " (" + p.type + ") " + p.lat + "," + p.lon); total++; });
      });
      if (!total) console.log("  No hay POIs.\n");
      else console.log("\nTotal: " + total + " POIs\n");
    },
    kick: (name) => {
      if (!name) { console.log("  Uso: kick <nombre>\n"); return; }
      const lower = name.toLowerCase();
      let found = false;
      Object.keys(sessions).forEach(sid => {
        Object.keys(sessions[sid].players).forEach(pid => {
          const p = sessions[sid].players[pid];
          if (p.name.toLowerCase() === lower) {
            const sock = io.sockets.sockets.get(p.socketId);
            if (sock) sock.disconnect(true);
            log(p.name + " expulsado de " + sid);
            found = true;
          }
        });
      });
      if (!found) console.log("  Jugador \"" + name + "\" no encontrado.\n");
    },
    limpiar: () => {
      Object.keys(sessions).forEach(sid => {
        const s = sessions[sid];
        Object.keys(s.objectives).forEach(oid => { if (s.objectives[oid].done) delete s.objectives[oid]; });
        io.to(sid).emit("objectives-update", s.objectives);
      });
      log("Objetivos completados limpiados.");
    },
    ip: () => {
      console.log("  Local: http://localhost:" + PORT);
      console.log("  Red:   http://" + getLocalIP() + ":" + PORT);
      if (global.publicUrl) console.log("  Web:   " + global.publicUrl);
      console.log("");
    },

    url: () => {
      if (global.publicUrl) console.log("  URL publica: " + global.publicUrl + "\n");
      else console.log("  No hay tunel activo. Usa la opcion 2 al iniciar.\n");
    },
    clear: () => { console.clear(); },
    ayuda: () => {
      console.log("\n  COMANDOS DISPONIBLES:");
      console.log("  jugadores          - Lista todos los jugadores conectados");
      console.log("  sessions           - Lista las sesiones activas");
      console.log("  broadcast <msg>    - Envia mensaje a todos los jugadores");

      console.log("  pois               - Lista todos los puntos de interes");
      console.log("  kick <nombre>      - Expulsa un jugador por su nombre");
      console.log("  limpiar            - Limpia objetivos completados");
      console.log("  ip                 - Muestra direcciones del servidor");
      console.log("  url                - Muestra la URL publica del tunel activo");
      console.log("  clear              - Limpia la pantalla");
      console.log("  ayuda              - Muestra esta ayuda");
      console.log("  salir              - Detiene el servidor\n");
    },
    salir: () => { rl.close(); process.exit(0); }
  };

  rl.on("line", line => {
    const parts = line.trim().match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    if (!parts.length || !parts[0]) { rl.prompt(); return; }
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1).map(s => s.replace(/^"|"$/g, "")).join(" ");
    // Multi-word commands (e.g. "token set", "token rm")
    const sub = parts[1] ? cmd + " " + parts[1].toLowerCase() : "";
    const subArgs = parts.slice(2).map(s => s.replace(/^"|"$/g, "")).join(" ");
    if (cmds[cmd]) cmds[cmd](args);
    else if (sub && cmds[sub] !== undefined) {
    }
    else if (cmd) console.log("  Comando desconocido. Escribe 'ayuda'.\n");
    rl.prompt();
  });
  rl.on("close", () => process.exit(0));
  setTimeout(() => rl.prompt(), 100);
}

process.on("SIGINT", async () => {
  console.log("");
  if (cloudflaredProcess) {
    try { cloudflaredProcess.kill(); } catch(e) {}
    cloudflaredProcess = null;
  }
  console.log("[INFO] Servidor detenido. Hasta la proxima mision!\n");
  process.exit(0);
});

main().catch(err => {
  console.error("[FATAL] " + err.message);
  process.exit(1);
});
