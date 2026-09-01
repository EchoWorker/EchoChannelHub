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

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, { ...securityHeaders, "Content-Type": type }); res.end(body);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { const b=Buffer.from(chunk); size+=b.length; if(size>4096) throw new Error("body too large"); chunks.push(b); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
}

export async function startSetupServer(callbacks: {
  snapshot(): SetupSnapshot;
  submitCode(code: string): void;
  cancel(): void;
}): Promise<SetupServer> {
  const cap = randomBytes(32).toString("base64url");
  const prefix = `/setup/${cap}`;
  const server = http.createServer(async (req,res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (!url.pathname.startsWith(prefix) || (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`))) return send(res,404,"text/plain; charset=utf-8","Not found");
      const route=url.pathname.slice(prefix.length)||"/";
      if(req.method==="GET"&&route==="/") return send(res,200,"text/html; charset=utf-8",renderSetupPage());
      if(req.method==="GET"&&route==="/status") return send(res,200,"application/json; charset=utf-8",JSON.stringify(callbacks.snapshot()));
      if(req.method==="GET"&&route==="/qr.png") { const q=callbacks.snapshot().qrUrl; if(!q)return send(res,404,"text/plain","No QR"); return send(res,200,"image/png",await QRCode.toBuffer(q,{errorCorrectionLevel:"H",margin:2,width:560})); }
      if(req.method==="POST"&&route==="/verify") { if(req.headers["content-type"]?.split(";")[0]!=="application/json")return send(res,415,"text/plain","JSON required"); const b=await readJson(req); callbacks.submitCode(typeof b.code==="string"?b.code:""); return send(res,204,"text/plain",""); }
      if(req.method==="POST"&&route==="/cancel") { callbacks.cancel(); return send(res,204,"text/plain",""); }
      return send(res,405,"text/plain","Method not allowed");
    } catch { return send(res,400,"text/plain","Bad request"); }
  });
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",()=>resolve())});
  const address=server.address(); if(!address||typeof address==="string")throw new Error("loopback listen failed");
  return { url:`http://127.0.0.1:${address.port}${prefix}`, close:()=>new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve())) };
}
