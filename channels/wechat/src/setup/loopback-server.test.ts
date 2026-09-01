import test from "node:test";
import assert from "node:assert/strict";
import { startSetupServer } from "./loopback-server.js";

test("setup server binds exact loopback capability and security headers", async () => {
  let cancelled=false, code="";
  const server=await startSetupServer({snapshot:()=>({status:"wait",message:"waiting",qrUrl:"hello",qrVersion:1}),submitCode:v=>{code=v},cancel:()=>{cancelled=true}});
  try {
    const url=new URL(server.url);
    assert.equal(url.hostname,"127.0.0.1"); assert.ok(Number(url.port)>=1024);
    assert.match(url.pathname,/^\/setup\/[A-Za-z0-9_-]{43}$/);
    const page=await fetch(server.url); assert.equal(page.status,200); assert.equal(page.headers.get("cache-control"),"no-store"); assert.match(page.headers.get("content-security-policy")??"",/frame-ancestors 'none'/);
    assert.equal((await fetch(`${url.origin}/setup/wrong`)).status,404);
    assert.equal((await fetch(`${server.url}/verify`,{method:"POST",headers:{"content-type":"text/plain"},body:"{}"})).status,415);
    assert.equal((await fetch(`${server.url}/verify`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({code:"1234"})})).status,204); assert.equal(code,"1234");
    await fetch(`${server.url}/cancel`,{method:"POST",headers:{"content-type":"application/json"},body:"{}"}); assert.equal(cancelled,true);
  } finally { await server.close(); }
});
