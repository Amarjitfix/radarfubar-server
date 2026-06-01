const http = require("http");

const SERVER = process.env.SERVER || "http://localhost:3000";
const PASSWORD = process.env.ADMIN_PW || "fubar";
const cmd = process.argv[2];
const arg = process.argv.slice(3).join(" ");
const U = new URL(SERVER);

function api(path) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: U.hostname, port: U.port, path, timeout: 5000 }, r => {
      let d = "";
      r.on("data", c => d += c);
      r.on("end", () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    }).on("error", reject);
  });
}

function post(path, body) {
  return new Promise((resolve, reject) => {
    const j = JSON.stringify(body);
    const r = http.request({ hostname: U.hostname, port: U.port, path, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(j) }, timeout: 5000 }, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } });
    });
    r.on("error", reject);
    r.write(j); r.end();
  });
}

async function main() {
  if (cmd === "status" || cmd === "players") {
    const data = await api("/api/status");
    let total = 0;
    const sids = Object.keys(data.sessions);
    if (!sids.length) { console.log("No hay sesiones activas."); return; }
    sids.forEach(sid => {
      const s = data.sessions[sid];
      console.log("\n[" + sid + "]");
      if (cmd === "status") console.log("  Jugadores: " + s.players.length + " | POIs: " + s.pois.length + " | Escuadras: " + s.squads.length);
      s.players.forEach(p => {
        const f = (p.hasGPS ? "G" : "-") + (p.bodycam ? "C" : "-") + (p.isAdmin ? "A" : "-");
        console.log("  " + p.name.padEnd(16) + " " + p.section.padEnd(12) + " [" + f + "] " + (p.replica || "?"));
        total++;
      });
    });
    console.log("\nTotal: " + total + " jugadores\n");
    return;
  }

  if (cmd === "broadcast") {
    if (!arg) { console.log("Uso: node gestion.js broadcast <mensaje>"); process.exit(1); }
    const r = await post("/api/broadcast", { password: PASSWORD, message: arg });
    if (r.ok) console.log("Broadcast enviado: " + arg);
    else console.log("Error: " + (r.error || "desconocido"));
    return;
  }

  if (cmd === "sessions" || cmd === "sesiones") {
    const data = await api("/api/status");
    const sids = Object.keys(data.sessions);
    if (!sids.length) { console.log("No hay sesiones activas."); return; }
    sids.forEach(sid => {
      const s = data.sessions[sid];
      console.log("  " + sid + " | " + s.players.length + " jug | " + s.pois.length + " POI | " + s.squads.length + " esc");
    });
    return;
  }

  if (cmd === "ip") {
    console.log("Servidor: " + SERVER);
    return;
  }

  console.log("\n  GESTION RADARFUBAR - Comandos:");
  console.log("  status                - Estado del servidor y jugadores");
  console.log("  players               - Listar jugadores");
  console.log("  sessions              - Listar sesiones activas");
  console.log("  broadcast <mensaje>   - Enviar mensaje a todos");
  console.log("  ip                    - Mostrar URL del servidor");
  console.log("  Variables: SERVER=http://IP:3000  ADMIN_PW=clave\n");
}

main().catch(err => { console.error("Error: " + err.message); process.exit(1); });
