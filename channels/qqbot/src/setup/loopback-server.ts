import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { renderSetupPage } from "./page.js";

export type SetupCredentials = { appId: string; appSecret: string };
export type SetupServer = { url: string; close(): Promise<void> };

const BODY_LIMIT = 4096;
const headers = {
  "Cache-Control": "no-store",
  "Pragma": "no-cache",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { ...headers, "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

function exactHost(req: IncomingMessage, expected: string): boolean {
  const values: string[] = [];
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index]?.toLowerCase() === "host") values.push(req.rawHeaders[index + 1] ?? "");
  }
  return values.length === 1 && values[0] === expected;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const length = req.headers["content-length"];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > BODY_LIMIT)) throw new Error("body too large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > BODY_LIMIT) throw new Error("body too large");
    chunks.push(bytes);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
  return value as Record<string, unknown>;
}

export async function startSetupServer(
  onSubmit: (credentials: SetupCredentials) => void | Promise<void>,
  onCancel: () => void = () => undefined,
): Promise<SetupServer> {
  const prefix = `/setup/${randomBytes(32).toString("base64url")}`;
  let expectedHost = "";
  const server = http.createServer(async (req, res) => {
    try {
      if (!exactHost(req, expectedHost)) return send(res, 400, "Bad request");
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (!url.pathname.startsWith(prefix) || (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) || url.search) return send(res, 404, "Not found");
      const route = url.pathname.slice(prefix.length) || "/";
      const allowedMethod = route === "/verify" || route === "/cancel" ? "POST" : "GET";
      if (!["/", "/status", "/verify", "/cancel"].includes(route)) return send(res, 404, "Not found");
      if (req.method !== allowedMethod) {
        res.writeHead(405, { ...headers, "Content-Type": "text/plain; charset=utf-8", Allow: allowedMethod });
        return res.end("Method not allowed");
      }
      if (req.method === "GET" && route === "/") {
        res.writeHead(200, { ...headers, "Content-Type": "text/html; charset=utf-8" });
        return res.end(renderSetupPage());
      }
      if (req.method === "GET" && route === "/status") return send(res, 200, "ready");
      if (req.headers["content-type"] !== "application/json") return send(res, 415, "JSON required");
      const body = await readBody(req);
      if (route === "/cancel") {
        if (Object.keys(body).length) return send(res, 400, "Invalid body");
        onCancel();
        return send(res, 204, "");
      }
      const keys = Object.keys(body).sort();
      if (keys.join(",") !== "appId,appSecret" || typeof body.appId !== "string" || typeof body.appSecret !== "string") {
        return send(res, 400, "Invalid body");
      }
      await onSubmit({ appId: body.appId, appSecret: body.appSecret });
      res.writeHead(204, headers);
      return res.end();
    } catch {
      return send(res, 400, "Bad request");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Loopback listen failed");
  expectedHost = `127.0.0.1:${address.port}`;
  return {
    url: `http://${expectedHost}${prefix}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
