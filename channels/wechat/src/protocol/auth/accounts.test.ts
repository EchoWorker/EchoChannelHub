import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listWeixinAccountIds, registerWeixinAccountId, saveWeixinAccount, resolveWeixinAccount } from "./accounts.js";

test("account index and credentials use exact selectable profile ids", () => {
  const old=process.env.ECHO_WECHAT_STATE_DIR; const dir=fs.mkdtempSync(path.join(os.tmpdir(),"wechat-accounts-")); process.env.ECHO_WECHAT_STATE_DIR=dir;
  try {
    saveWeixinAccount("first-im-bot",{token:"secret-1"}); registerWeixinAccountId("first-im-bot");
    saveWeixinAccount("second-im-bot",{token:"secret-2"}); registerWeixinAccountId("second-im-bot");
    assert.deepEqual(listWeixinAccountIds(),["first-im-bot","second-im-bot"]);
    assert.equal(resolveWeixinAccount("first@im.bot").token,"secret-1");
    if (process.platform !== "win32") assert.equal(fs.statSync(path.join(dir,"accounts-index","accounts","first-im-bot.json")).mode & 0o777,0o600);
  } finally { if(old===undefined)delete process.env.ECHO_WECHAT_STATE_DIR; else process.env.ECHO_WECHAT_STATE_DIR=old; fs.rmSync(dir,{recursive:true,force:true}); }
});
