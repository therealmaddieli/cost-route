/**
 * Screenshot a page at real phone widths, through the DevTools protocol.
 *
 * ## Why this exists instead of `chrome --screenshot --window-size=400,20000`
 *
 * macOS will not make a Chrome window narrower than roughly 500 CSS pixels. Asking for a 400px
 * window lays the page out at 500 and crops the image to 400, so the text is cut off mid-word at
 * the right edge and every row looks like it has ink running off it. On 2026-09-15 that produced a
 * false horizontal-overflow alarm on a page that had none: the picture was broken, not the layout.
 *
 * `Emulation.setDeviceMetricsOverride` sets the viewport rather than the window, so the layout width
 * and the requested width are the same number. That is the only way a responsive check at 360 or
 * 400 means anything here.
 *
 * It also prints `innerWidth` and `scrollWidth` for each width, because a screenshot shows an
 * overflow and the two numbers say whether one exists. The picture is for reading; the numbers are
 * for deciding.
 *
 * Usage:
 *   node scripts/shot.mjs out/report.html out/shots 360 400
 *   node scripts/shot.mjs out/report.html out/shots 360 --at=figure --at=table
 *   node scripts/shot.mjs out/report.html out/shots 360 --click=.tabs button:nth-child(2) --at=.shots
 *
 *   # An authenticated local page (the n8n canvas), in a sandboxed environment:
 *   node scripts/shot.mjs http://127.0.0.1:5678/workflow/<id> docs/n8n-canvas 1680 \
 *     --cookie="n8n-auth=<jwt>@127.0.0.1" --wait=".vue-flow__node" --no-sandbox
 *
 * `--no-sandbox` is opt-in rather than default: it weakens Chrome's own process isolation, which is
 * a real downgrade to hand a screenshot tool by default. It exists for containers and sandboxes
 * where Chrome cannot start otherwise.
 *
 * Writes <prefix>-<width>.png per width, plus <prefix>-<width>-bottom.png of the page's foot, since
 * a full-page image of a 5 MB report is taller than anything worth reading in one look. A 360x13149
 * screenshot is legible to a script and not to a person; `--at` clips the image to one element, so
 * what comes back is a few hundred pixels tall and can actually be looked at.
 */

import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import crypto from "node:crypto";
import { execFile } from "node:child_process";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;

// ---------------------------------------------------------------------------
// a websocket client, because Node 20 has no global WebSocket
// ---------------------------------------------------------------------------

/** One text frame, masked, which is what a client is required to send. */
function encodeFrame(payload) {
  const data = Buffer.from(payload, "utf8");
  const mask = crypto.randomBytes(4);
  const len = data.length;

  let header;
  if (len < 126) {
    header = Buffer.alloc(6);
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.alloc(8);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(14);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x81; // FIN + text opcode
  mask.copy(header, header.length - 4);

  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i += 1) masked[i] = data[i] ^ mask[i % 4];
  return Buffer.concat([header, masked]);
}

/**
 * A CDP connection. Messages are JSON with an incrementing id; a response carries that id and an
 * event carries a method and no id, and both arrive on the same stream.
 */
class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);

    socket.on("data", (chunk) => this.onData(chunk));
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    // Frames are consumed until one is incomplete. The payload length encoding is read rather than
    // assumed, because a screenshot is megabytes and will always take the 64-bit branch.
    for (;;) {
      const buf = this.buffer;
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      const len0 = buf[1] & 0x7f;
      let offset = 2;
      let len = len0;

      if (len0 === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len0 === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        offset = 10;
      }
      if (buf.length < offset + len) return;

      const payload = buf.subarray(offset, offset + len);
      this.buffer = buf.subarray(offset + len);

      // A close frame ends the reader; a ping is answered so Chrome does not drop us mid-run.
      if (opcode === 0x8) return;
      if (opcode === 0x9) {
        this.socket.write(encodeFrame(""));
        continue;
      }
      if (opcode !== 0x1) continue;

      let msg;
      try {
        msg = JSON.parse(payload.toString("utf8"));
      } catch {
        continue;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? "")})`));
        else resolve(msg.result);
      }
    }
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(encodeFrame(JSON.stringify({ id, method, params })));
    });
  }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const key = crypto.randomBytes(16).toString("base64");
    const socket = net.connect(Number(u.port), u.hostname, () => {
      socket.write(
        `GET ${u.pathname} HTTP/1.1\r\n` +
          `Host: ${u.host}\r\n` +
          "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
    });
    socket.on("error", reject);

    // The handshake is read off the socket before the frame reader is allowed to see any of it.
    let handshake = Buffer.alloc(0);
    const onHandshake = (chunk) => {
      handshake = Buffer.concat([handshake, chunk]);
      const end = handshake.indexOf("\r\n\r\n");
      if (end === -1) return;
      socket.off("data", onHandshake);
      const head = handshake.subarray(0, end).toString("utf8");
      if (!/^HTTP\/1\.1 101/.test(head)) return reject(new Error(`handshake failed: ${head.split("\r\n")[0]}`));
      const rest = handshake.subarray(end + 4);
      const cdp = new Cdp(socket);
      if (rest.length) cdp.onData(rest);
      resolve(cdp);
    };
    socket.on("data", onHandshake);
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    }).on("error", reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const flags = new Set();
  const ats = [];
  let click = null;
  let waitFor = null;
  let cookie = null;
  for (const a of argv.filter((a) => a.startsWith("--"))) {
    if (a.startsWith("--at=")) ats.push(a.slice(5));
    else if (a.startsWith("--click=")) click = a.slice(8);
    else if (a.startsWith("--wait=")) waitFor = a.slice(7);
    else if (a.startsWith("--cookie=")) cookie = a.slice(9);
    else flags.add(a);
  }
  const [htmlFile, prefix, ...widths] = argv.filter((a) => !a.startsWith("--"));
  if (!htmlFile || !prefix) {
    console.error("usage: node scripts/shot.mjs <html-file|url> <out-prefix> [widths...] [--at=sel] [--click=sel]");
    process.exit(2);
  }
  const sizes = widths.length ? widths.map(Number) : [360, 400];
  // The target may be a file on disk or the deployed page. Day 4's lesson was that a local file and
  // the host's copy of it are not the same document, so the pass that decides whether the published
  // page is right has to be run against the published page.
  const isUrl = /^https?:\/\//.test(htmlFile);
  const abs = path.resolve(htmlFile);
  const targetUrl = isUrl ? htmlFile : `file://${abs}`;
  const profile = fs.mkdtempSync("/tmp/cost-route-chrome-");

  const chrome = execFile(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    ...(flags.has("--no-sandbox") ? ["--no-sandbox", "--disable-gpu"] : []),
    "about:blank",
  ]);

  try {
    // Chrome takes a moment to open the debugging port. Poll rather than sleep a fixed guess.
    let version = null;
    for (let i = 0; i < 60 && !version; i += 1) {
      try {
        version = await getJson(`http://127.0.0.1:${PORT}/json/version`);
      } catch {
        await sleep(150);
      }
    }
    if (!version) throw new Error("Chrome never opened its debugging port");

    // The already-open blank tab, rather than `/json/new`, which current Chrome answers with
    // "Using unsafe HTTP verb GET to invoke /json/new. This action supports only PUT verb."
    const targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
    const target = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (!target) throw new Error("no page target to attach to");
    const cdp = await connect(target.webSocketDebuggerUrl);
    await cdp.send("Page.enable");

    // An authenticated page needs its session cookie before the first navigation, or the request
    // lands on the sign-in page and the screenshot is of the wrong document.
    if (cookie) {
      await cdp.send("Network.enable");
      const at = cookie.lastIndexOf("@");
      const pair = at === -1 ? cookie : cookie.slice(0, at);
      const domain = at === -1 ? "127.0.0.1" : cookie.slice(at + 1);
      const eq = pair.indexOf("=");
      if (eq === -1) throw new Error(`--cookie must be name=value[@host], got ${cookie}`);
      await cdp.send("Network.setCookie", {
        name: pair.slice(0, eq),
        value: pair.slice(eq + 1),
        domain,
        path: "/",
        httpOnly: true,
      });
    }

    for (const width of sizes) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await cdp.send("Page.navigate", { url: targetUrl });
      // The page is one file with no network of any kind, so load fires almost immediately; the
      // wait is for the image decode, which is what the first frame actually needs.
      if (isUrl) {
        // A live URL adds the download of a 3.7 MB document on top of that. Wait for the document
        // to be there before starting the decode wait, and give up loudly rather than measuring a
        // blank page. `about:blank` is already `complete` with an empty body, so the body check is
        // what makes this wait for the real navigation instead of the one before it.
        const deadline = Date.now() + 30000;
        for (;;) {
          const ready = await cdp.send("Runtime.evaluate", {
            expression:
              "document.readyState === 'complete' && !!document.body && document.body.childElementCount > 0",
            returnByValue: true,
          });
          if (ready.result.value === true) break;
          if (Date.now() > deadline) throw new Error(`live page never loaded: ${targetUrl}`);
          await sleep(250);
        }
      }
      await sleep(1200);

      // A tab has to be switched before anything is measured, or the numbers below describe the
      // first tab while the caller believes they describe the one it named.
      if (click) {
        const r = await cdp.send("Runtime.evaluate", {
          expression: `(function () { var el = document.querySelector(${JSON.stringify(click)});
            if (!el) return "missing"; el.click(); return "clicked"; })()`,
          returnByValue: true,
        });
        if (r.result.value !== "clicked") throw new Error(`--click=${click} found ${r.result.value}`);
        await sleep(400);
      }

      // A single-page editor (the n8n canvas) is not "loaded" in any way the navigation event knows
      // about: the document fires load long before the graph is painted. Waiting on an element the
      // app itself renders is the only signal that the screenshot will contain the thing asked for.
      if (waitFor) {
        const deadline = Date.now() + 30000;
        for (;;) {
          const r = await cdp.send("Runtime.evaluate", {
            expression: `!!document.querySelector(${JSON.stringify(waitFor)})`,
            returnByValue: true,
          });
          if (r.result.value === true) break;
          if (Date.now() > deadline) throw new Error(`--wait=${waitFor} never appeared`);
          await sleep(250);
        }
        await sleep(800);
      }

      const { result } = await cdp.send("Runtime.evaluate", {
        expression:
          "JSON.stringify({ inner: window.innerWidth, scroll: document.documentElement.scrollWidth, " +
          "height: document.documentElement.scrollHeight, " +
          "panels: document.querySelectorAll('[data-workload]').length, " +
          "visible: Array.prototype.map.call(document.querySelectorAll('[data-workload]'), " +
          "function (p) { return p.hasAttribute('hidden'); }) })",
        returnByValue: true,
      });
      const m = JSON.parse(result.value);
      const overflows = m.scroll > m.inner;
      console.log(
        `  ${width}px  innerWidth ${m.inner}  scrollWidth ${m.scroll}  height ${m.height}  ` +
          `panels ${m.panels} hidden=[${m.visible}]  ${overflows ? "OVERFLOWS" : "fits"}`
      );

      const full = await cdp.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
      });
      fs.writeFileSync(`${prefix}-${width}.png`, Buffer.from(full.data, "base64"));

      // A full-page image of a 5 MB report is thousands of pixels tall and unreadable in one look,
      // so the foot of the page gets its own shot at the same width.
      await cdp.send("Runtime.evaluate", {
        expression: "window.scrollTo(0, document.documentElement.scrollHeight)",
        returnByValue: true,
      });
      await sleep(250);
      const bottom = await cdp.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(`${prefix}-${width}-bottom.png`, Buffer.from(bottom.data, "base64"));

      // One clipped image per named element, which is the only form of this that a person can
      // read. `clip` is in page coordinates and needs captureBeyondViewport alongside it, because
      // an element below the fold is not in the viewport the compositor would otherwise draw.
      let n = 0;
      for (const sel of ats) {
        n += 1;
        const box = await cdp.send("Runtime.evaluate", {
          expression: `(function () { var el = document.querySelector(${JSON.stringify(sel)});
            if (!el) return "missing"; var r = el.getBoundingClientRect();
            return JSON.stringify({ x: r.left + window.scrollX, y: r.top + window.scrollY,
              w: r.width, h: r.height }); })()`,
          returnByValue: true,
        });
        if (box.result.value === "missing") throw new Error(`--at=${sel} matched nothing`);
        const b = JSON.parse(box.result.value);
        if (!b.w || !b.h) throw new Error(`--at=${sel} matched an element with no box`);
        const shot = await cdp.send("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: true,
          clip: { x: b.x, y: b.y, width: b.w, height: b.h, scale: 1 },
        });
        const name = `${prefix}-${width}-${n}-${sel.replace(/[^a-z0-9]+/gi, "_").slice(0, 24)}.png`;
        fs.writeFileSync(name, Buffer.from(shot.data, "base64"));
        console.log(`  at           ${sel}  ${Math.round(b.w)}x${Math.round(b.h)}  -> ${name}`);
      }
    }

    console.log(`  wrote        ${sizes.map((w) => `${prefix}-${w}.png`).join(", ")}`);
  } finally {
    // Cleanup must never be what the run reports. On the first attempt the profile sweep raced
    // Chrome's own cache writer, threw ENOTEMPTY out of `finally`, and took the place of a real
    // failure that had happened earlier in the try block - the run looked like a temp-directory
    // problem and was not.
    if (chrome.exitCode === null) {
      chrome.kill();
      await new Promise((resolve) => chrome.on("exit", resolve));
    }
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {
      // A leftover temp directory is not worth failing a run over, and /tmp clears itself.
    }
  }
}

main().catch((e) => {
  console.error(`  FAILED       ${e.message}`);
  process.exit(1);
});
