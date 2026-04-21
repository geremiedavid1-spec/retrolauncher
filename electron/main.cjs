const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const child_process = require("child_process");
const AdmZip = require("adm-zip");
const Database = require("better-sqlite3");
const crypto = require("crypto");

const config = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config.json"), "utf-8"));
const systems = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "systems.json"), "utf-8"));

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function sha1(s) { return crypto.createHash("sha1").update(s).digest("hex"); }

function openDb() {
  ensureDir(path.dirname(config.dbPath));
  const db = new Database(config.dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      system TEXT NOT NULL,
      sourcePath TEXT NOT NULL,
      isFavorite INTEGER DEFAULT 0,
      lastPlayedAt TEXT,
      playCount INTEGER DEFAULT 0
    );
  `);
  return db;
}

function detectSystemFromPath(filePath) {
  const p = filePath.toLowerCase();
  if (p.includes("\\gb\\")) return "GB";
  if (p.includes("\\gbc\\")) return "GBC";
  if (p.includes("\\gba\\")) return "GBA";
  if (p.includes("\\gg\\")) return "GG";
  if (p.includes("\\lnx\\")) return "LNX";
  if (p.includes("\\md\\") || p.includes("\\sega genesis\\") || p.includes("\\sega mega drive")) return "MD";
  if (p.includes("\\nintendo nes\\roms\\")) return "NES";
  if (p.includes("\\neo geo\\roms\\")) return "NEOGEO";
  return null;
}

function listGames() {
  const db = openDb();
  const games = db.prepare(`
    SELECT id, title, system, sourcePath, isFavorite, lastPlayedAt, playCount
    FROM games
    ORDER BY isFavorite DESC, lastPlayedAt DESC, title ASC
  `).all();
  db.close();
  return games;
}

function extractSingleRomFromZip(zipPath, allowedExts) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries().filter(e => !e.isDirectory);
  const matches = entries.filter(e => allowedExts.includes(path.extname(e.entryName).toLowerCase()));
  if (matches.length !== 1) {
    throw new Error(`Zip ambigu: ${matches.length} ROM(s) dans ${path.basename(zipPath)}`);
  }

  const entry = matches[0];
  const hash = sha1(zipPath);
  const outDir = path.join(config.cacheDir, hash);
  ensureDir(outDir);

  const outPath = path.join(outDir, path.basename(entry.entryName));
  if (!fs.existsSync(outPath)) {
    fs.writeFileSync(outPath, entry.getData());
  }
  return outPath;
}

function launchGame(game) {
  const sysCfg = systems[game.system];
  if (!sysCfg) throw new Error(`Système non supporté: ${game.system}`);

  if (sysCfg.type === "retroarch") {
    const corePath = path.join(config.retroarchCoresDir, sysCfg.core);
    child_process.spawn(config.retroarchExe, ["-L", corePath, game.sourcePath], { detached: true, stdio: "ignore" }).unref();
  } else if (sysCfg.type === "fceux_zip_single_nes") {
    const romPath = extractSingleRomFromZip(game.sourcePath, sysCfg.romExtInsideZip);
    child_process.spawn(config.fceuxExe, [romPath], { detached: true, stdio: "ignore" }).unref();
  } else if (sysCfg.type === "neoragex_open_only") {
    child_process.spawn(config.neoRagexExe, [], { detached: true, stdio: "ignore" }).unref();
  }

  const db = openDb();
  db.prepare(`
    UPDATE games
    SET lastPlayedAt = datetime('now'),
        playCount = playCount + 1
    WHERE id = ?
  `).run(game.id);
  db.close();
}

function scanGamesWithProgress(sendProgress) {
  const db = openDb();
  const rowsBefore = db.prepare("SELECT COUNT(*) as c FROM games").get().c;

  let filesSeen = 0;
  let gamesAdded = 0;

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      sendProgress({ phase: "scan", message: `Accès refusé: ${dir}` });
      return;
    }

    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else {
        filesSeen++;
        if (filesSeen % 250 === 0) {
          sendProgress({ phase: "scan", filesSeen, gamesAdded, message: `Analyse... (${filesSeen} fichiers)` });
        }

        const ext = path.extname(e.name).toLowerCase();
        const sys = detectSystemFromPath(full);
        if (!sys) continue;

        const sysCfg = systems[sys];
        if (!sysCfg) continue;
        if (sysCfg.ext && !sysCfg.ext.includes(ext)) continue;

        const id = sha1(full);
        const title = path.parse(e.name).name;

        const res = db.prepare("INSERT OR IGNORE INTO games (id, title, system, sourcePath) VALUES (?, ?, ?, ?)")
          .run(id, title, sys, full);

        if (res.changes > 0) gamesAdded++;
      }
    }
  }

  sendProgress({ phase: "start", message: "Démarrage du scan..." });
  walk(config.retroRoot);
  sendProgress({ phase: "db", message: "Finalisation..." });

  const rowsAfter = db.prepare("SELECT COUNT(*) as c FROM games").get().c;
  db.close();

  sendProgress({ phase: "done", filesSeen, gamesAdded, total: rowsAfter, message: "Scan terminé." });
  return { added: rowsAfter - rowsBefore, total: rowsAfter };
}

ipcMain.handle("scan", (evt) => scanGamesWithProgress((payload) => evt.sender.send("scanProgress", payload)));
ipcMain.handle("listGames", () => listGames());
ipcMain.handle("play", (_evt, gameId) => {
  const db = openDb();
  const game = db.prepare("SELECT * FROM games WHERE id = ?").get(gameId);
  db.close();
  if (!game) throw new Error("Jeu introuvable");
  launchGame(game);
  return true;
});
ipcMain.handle("toggleFavorite", (_evt, gameId) => {
  const db = openDb();
  const g = db.prepare("SELECT isFavorite FROM games WHERE id = ?").get(gameId);
  db.prepare("UPDATE games SET isFavorite = ? WHERE id = ?").run(g.isFavorite ? 0 : 1, gameId);
  db.close();
  return true;
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: { preload: path.join(__dirname, "preload.cjs") }
  });

  if (!app.isPackaged) win.loadURL("http://localhost:5173");
  else win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
}

app.whenReady().then(createWindow);
