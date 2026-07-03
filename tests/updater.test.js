const test = require("node:test");
const assert = require("node:assert/strict");

function defineGlobal(name, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true
  });
  return () => {
    if (previous) {
      Object.defineProperty(globalThis, name, previous);
    } else {
      delete globalThis[name];
    }
  };
}

function freshUpdater() {
  const restoreLyricLens = defineGlobal("LyricLens", {});
  delete require.cache[require.resolve("../src/utils")];
  delete require.cache[require.resolve("../src/updater")];
  require("../src/utils");
  const Updater = require("../src/updater");
  return {
    Updater,
    restore: () => {
      restoreLyricLens();
      delete require.cache[require.resolve("../src/utils")];
      delete require.cache[require.resolve("../src/updater")];
    }
  };
}

function installDownloadStubs(bytes) {
  const writes = [];
  const removes = [];
  const restoreFetch = defineGlobal("fetch", async () => new Response(bytes));
  const restoreCrypto = defineGlobal("crypto", undefined);
  const restoreBetterncm = defineGlobal("betterncm", {
    fs: {
      writeFile(path, blob) {
        writes.push({ path, size: blob.size });
      },
      exists() {
        return false;
      },
      remove(path) {
        removes.push(path);
      }
    }
  });
  const restoreNative = defineGlobal("betterncm_native", { fs: {} });
  return {
    writes,
    removes,
    restore: () => {
      restoreNative();
      restoreBetterncm();
      restoreCrypto();
      restoreFetch();
    }
  };
}

test("downloadAndInstall verifies digest with JS fallback when crypto.subtle is unavailable", async () => {
  const { Updater, restore } = freshUpdater();
  const bytes = Buffer.alloc(12 * 1024, "a");
  const expectedHex = globalThis.LyricLens.Utils.sha256HexSync(bytes);
  const stubs = installDownloadStubs(bytes);
  try {
    const result = await Updater.downloadAndInstall({
      asset_size: bytes.length,
      asset_digest: `sha256:${expectedHex}`
    });

    assert.deepEqual(result, { ok: true, sizeBytes: bytes.length });
    assert.deepEqual(stubs.writes, [
      { path: "./plugins/LyricLens.plugin.download", size: bytes.length },
      { path: "./plugins/LyricLens.plugin", size: bytes.length }
    ]);
    assert.deepEqual(stubs.removes, ["./plugins/LyricLens.plugin.download"]);
  } finally {
    stubs.restore();
    restore();
  }
});

test("downloadAndInstall rejects bad digest without crypto.subtle", async () => {
  const { Updater, restore } = freshUpdater();
  const bytes = Buffer.alloc(12 * 1024, "b");
  const stubs = installDownloadStubs(bytes);
  try {
    const result = await Updater.downloadAndInstall({
      asset_size: bytes.length,
      asset_digest: `sha256:${"0".repeat(64)}`
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /SHA-256 校验失败/);
    assert.doesNotMatch(result.error, /crypto\.subtle/);
    assert.deepEqual(stubs.writes, []);
  } finally {
    stubs.restore();
    restore();
  }
});
