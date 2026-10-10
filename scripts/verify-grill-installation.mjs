import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { stdout } from "node:process";

const expectedFiles = [
  [".agents/skills/grill-me/SKILL.md", "880871d72a6770813f5728e0978b8550ae60c47c"],
  [".agents/skills/grill-me/README.md", "2748ba9a2352ef147ee33d954e6856a14d0ba430"],
  ["docs/licenses/grill-me.MIT.txt", "9e62be76633f7a7ec716d4f713407ebf1c39e75f"],
];

for (const [path, expectedBlob] of expectedFiles) {
  const bytes = await readFile(new URL(`../${path}`, import.meta.url));
  const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  assert.equal(blob, expectedBlob, `Upstream bytes differ: ${path}`);
}

const lock = JSON.parse(await readFile(new URL("../skills-lock.json", import.meta.url), "utf8"));
assert.equal(lock.version, 1);
assert.deepEqual(Object.keys(lock.skills), ["grill-me"]);
assert.deepEqual(lock.skills["grill-me"], {
  source: "satya-janghu/agent-skills",
  ref: "24b06ad34ef7b8ac46f666794e64a975bdd7fb9d",
  sourceType: "github",
  skillPath: "skills/grill-me/SKILL.md",
  computedHash: "6882854bc3e9628769ee35e93cbbb9820a748c2f303cc2816d29c9bdd388436a",
});

stdout.write(`${JSON.stringify({
  status: "UPSTREAM_BYTES_VERIFIED",
  upstreamCommit: "24b06ad34ef7b8ac46f666794e64a975bdd7fb9d",
  files: expectedFiles.map(([path]) => path),
  limitations: "Byte/lock identity only; not a completed interview, host auto-discovery proof or user approval.",
})}\n`);
