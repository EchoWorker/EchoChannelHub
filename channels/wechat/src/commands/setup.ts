import { DEFAULT_BASE_URL } from "../protocol/auth/accounts.js";
import { startWeixinLoginWithQr, waitForWeixinLogin, DEFAULT_ILINK_BOT_TYPE } from "../protocol/auth/login-qr.js";
import { persistWeixinLogin } from "../protocol/auth/persist-login.js";
import { startSetupServer, type SetupSnapshot } from "../setup/loopback-server.js";

export type SetupMode = "add" | "restore";
export type SetupOptions = { echoworkJson: boolean; sessionId: string; mode: SetupMode; account?: string };
const frame = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);

export async function runSetup(opts: SetupOptions): Promise<void> {
  const account = opts.account?.trim();
  if (!opts.echoworkJson || !opts.sessionId.trim() || !["add", "restore"].includes(opts.mode)
    || (opts.mode === "add" && account !== undefined) || (opts.mode === "restore" && !account)) {
    throw new Error("setup requires --mode add, or --mode restore --account <id>");
  }
  const abort = new AbortController();
  let verifyResolve: ((code: string) => void) | undefined;
  let snapshot: SetupSnapshot = { status: "starting", message: "正在生成二维码", qrVersion: 0 };
  const server = await startSetupServer({
    snapshot: () => ({ ...snapshot }),
    submitCode: (code) => { if (code.trim()) verifyResolve?.(code.trim()); },
    cancel: () => abort.abort(),
  });
  const onSignal = () => abort.abort();
  process.once("SIGINT", onSignal); process.once("SIGTERM", onSignal);
  try {
    frame({ type:"echowork.channel_setup.ready", version:1, session_id:opts.sessionId, url:server.url });
    const started = await startWeixinLoginWithQr({
      apiBaseUrl:DEFAULT_BASE_URL, botType:DEFAULT_ILINK_BOT_TYPE, force:true,
      mode:opts.mode, accountId:opts.mode === "restore" ? account : undefined,
      abortSignal:abort.signal,
    });
    if (!started.qrcodeUrl) throw new Error(started.message);
    snapshot = { status:"wait", message:"请用小号微信扫描二维码", qrUrl:started.qrcodeUrl, qrVersion:1 };
    const result = await waitForWeixinLogin({
      sessionKey:started.sessionKey, apiBaseUrl:DEFAULT_BASE_URL, botType:DEFAULT_ILINK_BOT_TYPE,
      timeoutMs:8*60_000, abortSignal:abort.signal,
      onStatus:(status)=>{ snapshot={...snapshot,status,message:status==="scaned"?"请在手机上确认":status==="need_verifycode"?"请输入手机显示的数字":"等待扫码"}; },
      onQrCode:(url)=>{ snapshot={...snapshot,status:"wait",message:"二维码已更新，请重新扫描",qrUrl:url,qrVersion:snapshot.qrVersion+1}; },
      readVerifyCode:()=>new Promise<string>((resolve,reject)=>{ verifyResolve=resolve; const cancel=()=>reject(new Error("登录已取消")); abort.signal.addEventListener("abort",cancel,{once:true}); }),
    });
    verifyResolve=undefined;
    if (abort.signal.aborted) { snapshot={...snapshot,status:"cancelled",message:"登录已取消"}; process.exitCode=1; return; }
    if (!result.connected) throw new Error(result.message);
    const profileId = result.alreadyConnected ? result.accountId! : persistWeixinLogin(result);
    if (opts.mode === "restore" && profileId !== account) throw new Error("恢复结果与指定账号不匹配");
    snapshot={...snapshot,status:"connected",message:"微信已连接"};
    frame({ type:"echowork.channel_setup.complete", version:1, session_id:opts.sessionId, profile_id:profileId });
  } catch (error) {
    snapshot={...snapshot,status:abort.signal.aborted?"cancelled":"failed",message:error instanceof Error?error.message:String(error)};
    process.stderr.write(`echo-wechat setup: ${snapshot.status}\n`); process.exitCode=1;
  } finally {
    process.removeListener("SIGINT",onSignal); process.removeListener("SIGTERM",onSignal);
    await server.close();
  }
}
