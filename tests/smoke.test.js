const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

test("manifest.json injects file list matches built plugin contents", () => {
  const root = path.resolve(__dirname, "..");
  const manifestPath = path.join(root, "manifest.json");
  assert.ok(fs.existsSync(manifestPath), "manifest.json must exist");

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const injects = manifest?.injects?.Main;
  assert.ok(Array.isArray(injects), "injects.Main must be an array");
  assert.ok(injects.length >= 5, "injects.Main must have at least 5 entries");

  const injectFiles = injects.map((entry) => entry.file);

  // Source layout: main.js at root, all others under src/
  const srcDir = path.join(root, "src");
  for (const file of injectFiles) {
    const srcCandidate = path.join(srcDir, file);
    const rootCandidate = path.join(root, file);
    const filePath = fs.existsSync(srcCandidate) ? srcCandidate : rootCandidate;
    assert.ok(
      fs.existsSync(filePath),
      `inject source file must exist: ${file} (checked ${srcCandidate}, ${rootCandidate})`
    );
    const stat = fs.statSync(filePath);
    assert.ok(stat.size > 0, `inject file must not be empty: ${file}`);
  }

  // Also verify styles/panel.css exists (referenced by styles.js at runtime)
  const cssPath = path.join(root, "styles", "panel.css");
  assert.ok(fs.existsSync(cssPath), "styles/panel.css must exist");

  // Verify every inject file is a flat name (no path separators)
  for (const file of injectFiles) {
    assert.ok(
      !file.includes("/") && !file.includes("\\"),
      `inject file must be flat (no directory): ${file}`
    );
  }
});

test("plugin zip contains all inject files at root level", () => {
  const root = path.resolve(__dirname, "..");
  const pluginPath = path.join(root, "LyricLens.plugin");

  if (!fs.existsSync(pluginPath)) {
    // Plugin not yet built — skip with a warning
    console.warn("Plugin file not found, skipping zip content check. Run build first.");
    return;
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const injectFiles = new Set(manifest.injects.Main.map((e) => e.file));

  // Read zip central directory
  const data = fs.readFileSync(pluginPath);
  const zipFiles = new Set();
  let off = data.length - 22;
  while (off >= 0) {
    if (data.readUInt32LE(off) === 0x06054b50) {
      const cdOff = data.readUInt32LE(off + 16);
      const totalEntries = data.readUInt16LE(off + 10);
      let p = cdOff;
      for (let i = 0; i < totalEntries; i++) {
        const sig = data.readUInt32LE(p);
        if (sig !== 0x02014b50) break;
        const fnLen = data.readUInt16LE(p + 28);
        const name = data.slice(p + 46, p + 46 + fnLen).toString("utf8");
        zipFiles.add(name);
        p += 46 + fnLen + data.readUInt16LE(p + 30) + data.readUInt16LE(p + 32);
      }
      break;
    }
    off--;
  }

  // Every inject file must be in the zip AT ROOT LEVEL (no directory prefix)
  for (const file of injectFiles) {
    assert.ok(
      zipFiles.has(file),
      `plugin zip must contain inject file at root: ${file} (zip contents: ${[...zipFiles].join(", ")})`
    );
  }
});
