// Arduino Classroom Uploader — compile server
//
// This is the piece that turns a student's sketch text into a compiled
// program (.hex file). It needs arduino-cli installed on this machine.
// The actual "send it to the board" step does NOT go through this server —
// that happens directly from the student's browser over WebSerial.
//
// Setup (one time, on whatever machine will run this):
//   1. Install arduino-cli: https://arduino.github.io/arduino-cli/latest/installation/
//   2. Run:  arduino-cli core update-index
//            arduino-cli core install arduino:avr
//   3. cd server && npm install
//   4. node server.js
//
// By default this listens on port 3131. Point the frontend's
// COMPILE_SERVER_URL (in public/index.html) at wherever this ends up
// running, e.g. http://192.168.1.50:3131 on your classroom LAN, or a
// public URL if you deploy it to a small cloud host.

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { v4: uuidv4 } = require("uuid");
const { execFile } = require("child_process");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");

const app = express();

// Render (like most hosts) puts your app behind its own proxy, so the raw
// connection Express sees is always Render's proxy, not the actual visitor
// — every single request would otherwise look like it's coming from the
// same place. This tells Express to trust the "who actually sent this"
// header Render adds, which the rate limiter below depends on to tell
// different students (or a bot) apart correctly.
app.set("trust proxy", 1);

app.use(cors());
app.use(express.json({ limit: "2mb" }));

// Caps how many /compile requests one network address can make per
// minute. Set generously — high enough that your whole class compiling
// in the same burst (a school WiFi often shares one public address, so
// this can mean your ENTIRE class, not just one student) sails through
// without issue, while still being a small fraction of what an actual
// spam attempt would try.
const compileLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: "Too many compile requests from your network in the last minute. Wait a moment and try again.",
  },
});

const PORT = process.env.PORT || 3131;

// The compiler binary's location — configurable via an environment
// variable so the exact same server.js works unchanged both on your own
// Windows machine (falls back to the path you already have working) and
// inside the Docker container this gets deployed in (which sets this
// environment variable itself, pointing at its own Linux install).
const ARDUINO_CLI = process.env.ARDUINO_CLI_PATH || "C:\\Users\\antho\\Downloads\\arduino-cli\\arduino-cli.exe";

// Board nicknames the frontend can request, mapped to arduino-cli FQBNs.
// Add more here if you use other boards.
const BOARD_FQBNS = {
  uno: "arduino:avr:uno",
  nano_new: "arduino:avr:nano:cpu=atmega328", // Nano with the newer bootloader
  nano_old: "arduino:avr:nano:cpu=atmega328old", // Nano with the older bootloader
};

// Simple concurrency limiter so 60 students hitting "Compile" at the same
// moment doesn't try to spawn 60 compilers at once.
// This was originally tuned against a real laptop's multiple CPU cores.
// Render's free tier gives this server a TENTH of one CPU core and
// 512MB of memory total — a completely different machine. Asking it to
// run 8 real compiler processes at once very plausibly exhausts that
// memory and crashes the whole server, taking every waiting request
// down with it. 2 is a safer ceiling for hardware this small; queued
// requests just wait their turn a bit longer instead of crashing.
const MAX_CONCURRENT_COMPILES = 2;
let active = 0;
const queue = [];

function runWithLimit(fn) {
  return new Promise((resolve, reject) => {
    const task = async () => {
      active++;
      try {
        resolve(await fn());
      } catch (err) {
        reject(err);
      } finally {
        active--;
        if (queue.length > 0) queue.shift()();
      }
    };
    if (active < MAX_CONCURRENT_COMPILES) task();
    else queue.push(task);
  });
}

function execFilePromise(cmd, args, opts) {
  return new Promise((resolve) => {
    execFile(cmd, args, opts, (error, stdout, stderr) => {
      resolve({ error, stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

app.post("/compile", compileLimiter, async (req, res) => {
  const { code, board } = req.body || {};

  if (typeof code !== "string" || !code.trim()) {
    return res.status(400).json({ success: false, error: "No code was submitted." });
  }
  const fqbn = BOARD_FQBNS[board];
  if (!fqbn) {
    return res.status(400).json({
      success: false,
      error: `Unknown board "${board}". Expected one of: ${Object.keys(BOARD_FQBNS).join(", ")}`,
    });
  }

  const jobId = uuidv4();
  const sketchName = `sketch_${jobId}`;
  const workDir = path.join(os.tmpdir(), "arduino-uploader", sketchName);
  const outDir = path.join(workDir, "build");

  try {
    await fs.mkdir(workDir, { recursive: true });
    await fs.mkdir(outDir, { recursive: true });
    // arduino-cli requires the .ino file to share its name with the folder.
    await fs.writeFile(path.join(workDir, `${sketchName}.ino`), code, "utf8");

    const result = await runWithLimit(() =>
      execFilePromise(
        ARDUINO_CLI,
        ["compile", "--fqbn", fqbn, workDir, "--output-dir", outDir],
        { timeout: 25000, maxBuffer: 10 * 1024 * 1024 }
      )
    );

    if (result.error) {
  console.error("Compile process error:", result.error.code, "-", result.error.message);
  // Compiler errors land in stdout for arduino-cli; surface both.
  const message = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();

  // A missing library produces a fairly cryptic GCC error. Translate
  // the common case into something a student can actually act on,
  // while still including the raw error underneath for you or a
  // curious student to see exactly what happened.
  const missingHeader = message.match(/fatal error:\s*([\w./-]+\.h):\s*No such file or directory/);
  if (missingHeader) {
    const libName = missingHeader[1].replace(/\.h$/, "");
    return res.json({
      success: false,
      error:
        `This sketch needs a library called "${libName}" that isn't installed on the server yet. ` +
        `Ask your teacher to install it (arduino-cli lib install "${libName}").\n\n` +
        `Details:\n${message}`,
    });
  }

  return res.json({
    success: false,
    error: message || "Compilation failed (no details returned).",
  });
}

    const hexPath = path.join(outDir, `${sketchName}.ino.hex`);
    const hexBuffer = await fs.readFile(hexPath);

    return res.json({
      success: true,
      hex: hexBuffer.toString("base64"),
      log: result.stdout,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  } finally {
    // Best-effort cleanup; don't let this block the response.
    fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Arduino compile server listening on port ${PORT}`);
  console.log(`Boards available: ${Object.keys(BOARD_FQBNS).join(", ")}`);
});
