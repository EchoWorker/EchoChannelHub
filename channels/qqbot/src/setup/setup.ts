import { restoreProfile, saveProfile } from "../profile/store.js";
import { startSetupServer } from "./loopback-server.js";

export type SetupMode = "add" | "restore";
export type SetupOptions = {
  sessionId: string;
  mode: SetupMode;
  account?: string;
  signal?: AbortSignal;
  writeFrame?: (frame: unknown) => void;
};

/** Execute the setup-v2 profile flow. Argument parsing remains the CLI's job. */
export async function runSetup(options: SetupOptions): Promise<string> {
  const sessionId = options.sessionId;
  if (!sessionId || /[\r\n]/.test(sessionId)) throw new Error("Invalid setup session ID");
  const write = options.writeFrame ?? ((frame) => process.stdout.write(`${JSON.stringify(frame)}\n`));

  if (options.mode === "restore") {
    if (!options.account || options.account.trim() !== options.account) throw new Error("Restore requires a profile ID");
    const profile = restoreProfile(options.account);
    write({ type: "echowork.channel_setup.complete", version: 1, session_id: sessionId, profile_id: profile.profileId });
    return profile.profileId;
  }
  if (options.mode !== "add" || options.account !== undefined) throw new Error("Add does not accept a profile ID");
  if (options.signal?.aborted) throw new Error("Setup cancelled");

  let resolveResult!: (profileId: string) => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<string>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  let submitted = false;
  const server = await startSetupServer(({ appId, appSecret }) => {
    if (submitted) throw new Error("Setup already submitted");
    const profile = saveProfile(appId, appSecret);
    submitted = true;
    resolveResult(profile.profileId);
  });
  const onAbort = () => rejectResult(new Error("Setup cancelled"));
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    write({ type: "echowork.channel_setup.ready", version: 1, session_id: sessionId, url: server.url });
    const profileId = await result;
    write({ type: "echowork.channel_setup.complete", version: 1, session_id: sessionId, profile_id: profileId });
    return profileId;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    await server.close();
  }
}
