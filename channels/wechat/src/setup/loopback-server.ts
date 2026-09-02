import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import QRCode from "qrcode";
import { renderSetupPage } from "./page.js";

export type SetupSnapshot = { status: string; message: string; qrUrl?: string; qrVersion: number };
export type SetupServer = { url: string; close(): Promise<void> };

const securityHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};

function send(res: ServerResponse, status: number, type: string, body: string | Buffer, extra: Record<string, string> = {}): void {
  res.writeHead(status, { ...securityHeaders, "Content-Type": type, ...extra });
  res.end(body);
}

function hasExactHost(req: IncomingMessage, expectedHost: string): boolean {
  const hosts: string[] = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i]?.toLowerCase() === "host") hosts.push(req.rawHeaders[i + 1] ?? "");
  }
  return hosts.length === 1 && hosts[0] === expectedHost;
}

function isJson(req: IncomingMessage): boolean {
  return req.headers["content-type"] === "application/json";
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 4096) throw new Error("body too large");
    chunks.push(bytes);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
  return value as Record<string, unknown>;
}

function hasExactKeys(body: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(body);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(body, key));
}

export async function startSetupServer(callbacks: {
  snapshot(): SetupSnapshot;
  submitCode(code: string): void;
  cancel(): void;
}): Promise<SetupServer> {
  const cap = randomBytes(32).toString("base64url");
  const prefix = `/setup/${cap}`;
  let expectedHost = "";
  const server = http.createServer(async (req, res) => {
    try {
      if (!hasExactHost(req, expectedHost)) return send(res, 400, "text/plain; charset=utf-8", "Bad request");
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (!url.pathname.startsWith(prefix) || (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`))) {
        return send(res, 404, "text/plain; charset=utf-8", "Not found");
      }
      const route = url.pathname.slice(prefix.length) || "/";
      const allowedMethod = route === "/verify" || route === "/cancel" ? "POST" : "GET";
      if (["/", "/status", "/qr.png", "/verify", "/cancel"].includes(route) && req.method !== allowedMethod) {
        return send(res, 405, "text/plain; charset=utf-8", "Method not allowed", { Allow: allowedMethod });
      }
      if (req.method === "GET" && route === "/") return send(res, 200, "text/html; charset=utf-8", renderSetupPage());
      if (req.method === "GET" && route === "/status") {
        const { status, message, qrVersion } = callbacks.snapshot();
        return send(res, 200, "application/json; charset=utf-8", JSON.stringify({ status, message, qrVersion }));
      }
      if (req.method === "GET" && route === "/qr.png") {
        const qrUrl = callbacks.snapshot().qrUrl;
        if (!qrUrl) return send(res, 404, "text/plain; charset=utf-8", "No QR");
        return send(res, 200, "image/png", await QRCode.toBuffer(qrUrl, { errorCorrectionLevel: "H", margin: 2, width: 560 }));
      }
      if (req.method === "POST" && route === "/verify") {
        if (!isJson(req)) return send(res, 415, "text/plain; charset=utf-8", "JSON required");
        const body = await readJson(req);
        if (!hasExactKeys(body, ["code"]) || typeof body.code !== "string" || !/^\d{1,12}$/.test(body.code)) {
          return send(res, 400, "text/plain; charset=utf-8", "Invalid body");
        }
        callbacks.submitCode(body.code);
        return send(res, 204, "text/plain; charset=utf-8", "");
      }
      if (req.method === "POST" && route === "/cancel") {
        if (!isJson(req)) return send(res, 415, "text/plain; charset=utf-8", "JSON required");
        const body = await readJson(req);
        if (!hasExactKeys(body, [])) return send(res, 400, "text/plain; charset=utf-8", "Invalid body");
        callbacks.cancel();
        return send(res, 204, "text/plain; charset=utf-8", "");
      }
      return send(res, 404, "text/plain; charset=utf-8", "Not found");
    } catch {
      return send(res, 400, "text/plain; charset=utf-8", "Bad request");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("loopback listen failed");
  expectedHost = `127.0.0.1:${address.port}`;
  return {
    url: `http://${expectedHost}${prefix}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
