/**
 * qr-html.ts — render a QR payload to an HTML file (inline PNG) and open it.
 *
 * The interactive QR login normally prints an ASCII QR to the terminal, but that
 * doesn't survive non-TTY contexts (background runners, redirected output). To
 * make login robust we also write the QR to an HTML file the user can open and
 * scan from any screen. Uses the `qrcode` library for a clean raster image.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import QRCode from "qrcode";

/**
 * Write the QR payload to an HTML file (with an inline PNG) and try to open it
 * in the default browser. Returns the file path.
 */
export async function writeQrHtml(payload: string, label = "Scan with WeChat"): Promise<string> {
  // High error-correction + decent scale so it scans reliably off a screen.
  const dataUri = await QRCode.toDataURL(payload, {
    errorCorrectionLevel: "H",
    margin: 2,
    scale: 8,
  });

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>echo-wechat login</title>
<style>body{font-family:system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;gap:12px;padding:40px;background:#f5f5f5}
.card{background:#fff;padding:24px 32px;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.1);text-align:center}
h1{font-size:18px;margin:0 0 4px}p{color:#666;font-size:13px;margin:4px 0}img{image-rendering:pixelated;width:280px;height:280px}</style></head>
<body><div class="card"><h1>echo-wechat 登录</h1><p>${label}</p>
<img src="${dataUri}" alt="QR"/>
<p style="margin-top:8px">用<b>小号</b>微信扫一扫</p></div></body></html>`;

  const file = path.join(os.tmpdir(), `echo-wechat-qr-${Date.now()}.html`);
  fs.writeFileSync(file, html, "utf-8");

  // Best-effort: open in default browser (cross-platform).
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", file], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [file], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [file], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    // ignore — the path is printed for manual opening
  }
  return file;
}
