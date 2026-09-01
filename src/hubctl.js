#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import yazl from "yazl";
import yauzl from "yauzl";
import { TARGET, TEST_KEY_ID, artifactManifest, loadChannels, makeCatalog, readJson, root, sha256, sign, slash, stableJson, validateCatalog, validateManifest, validateRepository, verifySignature, walkFiles } from "./lib.js";

function fail(message, code = 1) { process.stderr.write(`${message}\n`); process.exitCode = code; }
function run(command, args, cwd) {
  const executable = process.platform === "win32" && command === "npm" ? (process.env.ComSpec ?? "cmd.exe") : command;
  const commandArgs = process.platform === "win32" && command === "npm" ? ["/d", "/s", "/c", "npm.cmd", ...args] : args;
  const r = spawnSync(executable, commandArgs, { cwd, stdio: "inherit", shell: false });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${r.status})`);
}
function option(args, name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }
function copyFiltered(src, dest) { const excluded = new Set([".git", "node_modules", "dist", "artifacts"]); fs.cpSync(src, dest, { recursive: true, filter: s => !excluded.has(path.basename(s)) }); }
async function zipDirectory(source, output) {
  await new Promise((resolve, reject) => { const zip = new yazl.ZipFile(); for (const file of walkFiles(source)) zip.addFile(file, slash(path.relative(source, file)), { mtime: new Date("2000-01-01T00:00:00Z"), mode: 0o100644 }); zip.end(); zip.outputStream.pipe(fs.createWriteStream(output)).on("close", resolve).on("error", reject); });
}
async function zipEntries(file) {
  return new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true }, (error, zip) => { if (error) return reject(error); const entries = []; zip.readEntry(); zip.on("entry", e => { entries.push(e.fileName); zip.readEntry(); }); zip.on("end", () => resolve(entries)); zip.on("error", reject); }));
}
async function zipJson(file, wanted) {
  return new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true }, (error, zip) => { if (error) return reject(error); zip.readEntry(); zip.on("entry", e => { if (e.fileName !== wanted) return zip.readEntry(); zip.openReadStream(e, (err, stream) => { if (err) return reject(err); const chunks = []; stream.on("data", c => chunks.push(c)); stream.on("end", () => { zip.close(); try { resolve(JSON.parse(Buffer.concat(chunks))); } catch (x) { reject(x); } }); }); }); zip.on("end", () => reject(new Error(`${wanted} missing`))); }));
}
function catalogFiles() { return { json: path.join(root, "registry", "v1", "catalog.json"), signature: path.join(root, "registry", "v1", "catalog.json.sig") }; }
function writeSignedCatalog(value) { const { json, signature } = catalogFiles(); fs.mkdirSync(path.dirname(json), { recursive: true }); const bytes = Buffer.from(stableJson(value)); fs.writeFileSync(json, bytes); fs.writeFileSync(signature, `${sign(bytes)}\n`); }

export async function main(args = process.argv.slice(2)) {
  const [command, subject] = args;
  if (command === "validate") {
    const errors = validateRepository(root); const { json, signature } = catalogFiles();
    try { const bytes = fs.readFileSync(json); const c = JSON.parse(bytes); errors.push(...validateCatalog(c)); if (!verifySignature(bytes, fs.readFileSync(signature, "utf8").trim())) errors.push("catalog: invalid TEST ONLY signature"); } catch (e) { errors.push(`catalog: ${e.message}`); }
    if (errors.length) return fail(errors.join("\n")); process.stdout.write(`valid: ${loadChannels(root).length} channel(s), TEST ONLY signatures\n`); return;
  }
  if (command === "build-catalog") {
    const errors = validateRepository(root); if (errors.length) return fail(errors.join("\n"));
    const files = catalogFiles(); let prior; try { prior = readJson(files.json); } catch { prior = undefined; }
    const artifacts = Object.fromEntries(loadChannels(root).map(c => { const old = prior?.channels?.find(x => x.id === c.manifest.id)?.releases?.find(r => r.version === c.manifest.version)?.artifacts?.[TARGET]; if (!old) throw new Error(`no artifact metadata for ${c.manifest.id}; package it first`); return [c.manifest.id, old]; }));
    const value = makeCatalog(loadChannels(root), artifacts, { sequence: prior?.sequence ?? 1, generatedAt: prior?.generatedAt, expiresAt: prior?.expiresAt }); const output = stableJson(value);
    if (args.includes("--check")) { if (fs.readFileSync(files.json, "utf8") !== output) return fail("catalog is stale"); if (!verifySignature(Buffer.from(output), fs.readFileSync(files.signature, "utf8").trim())) return fail("catalog signature invalid"); process.stdout.write("catalog is current and TEST ONLY signature valid\n"); }
    else { writeSignedCatalog(value); process.stdout.write(`${files.json}\n${files.signature}\n`); } return;
  }
  if (command === "package") {
    if (!subject) return fail(`usage: hubctl package <channel> --target ${TARGET} [--bundle-runtime]`, 2);
    const channel = loadChannels(root).find(c => c.manifest.id === subject); if (!channel) return fail(`unknown channel: ${subject}`, 2);
    const target = option(args, "--target") ?? TARGET; if (target !== TARGET || channel.manifest.target !== TARGET) return fail(`unsupported or undeclared target: ${target}`, 2);
    if (process.platform !== "win32" || process.arch !== "x64") return fail(`${TARGET} candidates must be built on Windows x64`);
    run("npm", ["run", "build"], channel.dir); run("npm", ["test"], channel.dir);
    const artifactDir = path.join(root, "artifacts");
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), `echochannel-${subject}-`));
    fs.mkdirSync(path.join(stage, "payload", "app"), { recursive: true });
    copyFiltered(channel.dir, path.join(stage, "payload", "app")); fs.cpSync(path.join(channel.dir, "dist"), path.join(stage, "payload", "app", "dist"), { recursive: true }); run("npm", ["ci", "--omit=dev", "--ignore-scripts"], path.join(stage, "payload", "app"));
    const bundled = args.includes("--bundle-runtime"); if (bundled) { fs.mkdirSync(path.join(stage, "payload", "runtime")); fs.copyFileSync(process.execPath, path.join(stage, "payload", "runtime", "node.exe")); }
    fs.writeFileSync(path.join(stage, "payload", "echo-wechat.cmd"), bundled ? "@echo off\r\n\"%~dp0runtime\\node.exe\" \"%~dp0app\\dist\\cli.js\" %*\r\n" : "@echo off\r\nnode \"%~dp0app\\dist\\cli.js\" %*\r\n");
    fs.writeFileSync(path.join(stage, "manifest.json"), stableJson(artifactManifest(channel.manifest)));
    fs.mkdirSync(artifactDir, { recursive: true }); const artifact = path.join(artifactDir, `${subject}-${channel.manifest.version}-${TARGET}.echochannel`); fs.rmSync(artifact, { force: true }); await zipDirectory(stage, artifact); fs.rmSync(stage, { recursive: true, force: true });
    const bytes = fs.readFileSync(artifact); const metadata = { schemaVersion: 1, artifact: path.basename(artifact), target: TARGET, sha256: sha256(artifact), size: bytes.length, signature: sign(bytes), keyId: TEST_KEY_ID, testOnly: true }; fs.writeFileSync(`${artifact}.json`, stableJson(metadata));
    let prior; try { prior = readJson(catalogFiles().json); } catch {} const other = Object.fromEntries((prior?.channels ?? []).filter(c => c.id !== subject).map(c => [c.id, c.releases[0].artifacts[TARGET]]));
    const catalog = makeCatalog(loadChannels(root), { ...other, [subject]: { url: `https://github.com/EchoWorker/EchoChannelHub/releases/download/test-candidate/${path.basename(artifact)}`, size: metadata.size, sha256: metadata.sha256, signature: metadata.signature, keyId: TEST_KEY_ID } }, { sequence: (prior?.sequence ?? 0) + 1, generatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 86400000).toISOString() }); writeSignedCatalog(catalog);
    process.stdout.write(`${artifact}\n${artifact}.json\n`); return;
  }
  if (command === "verify") {
    if (!subject) return fail("usage: hubctl verify <file.echochannel>", 2); const artifact = path.resolve(subject); let meta;
    try { meta = readJson(`${artifact}.json`); } catch (e) { return fail(`invalid candidate sidecar: ${e.message}`); }
    const errors = []; if (meta.artifact !== path.basename(artifact) || meta.target !== TARGET || meta.keyId !== TEST_KEY_ID || meta.testOnly !== true || meta.size !== fs.statSync(artifact).size || meta.sha256 !== sha256(artifact) || !verifySignature(fs.readFileSync(artifact), meta.signature)) errors.push("candidate integrity or TEST ONLY signature failure");
    try { const entries = await zipEntries(artifact); if (!entries.includes("manifest.json") || entries.filter(e => e === "manifest.json").length !== 1) errors.push("archive must contain exactly one root manifest.json"); errors.push(...validateManifest(await zipJson(artifact, "manifest.json"))); } catch (e) { errors.push(`invalid ZIP: ${e.message}`); }
    if (errors.length) return fail(errors.join("\n")); process.stdout.write(`verified TEST ONLY signed candidate: ${path.basename(artifact)}\n`); return;
  }
  fail("usage: hubctl <validate|build-catalog|package|verify>", 2);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => fail(e.stack ?? e.message));
