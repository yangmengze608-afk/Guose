import { spawnSync } from "node:child_process";

const probe = `
  import { hashEntries } from ${JSON.stringify(new URL("../dist/repo/snapshot.js", import.meta.url).href)};
  import { createBundleContentFingerprint } from ${JSON.stringify(new URL("../dist/utils/content-hash.js", import.meta.url).href)};
  console.log(JSON.stringify({
    entries: hashEntries([["ä", "1"], ["z", "2"]]),
    object: createBundleContentFingerprint({ "ä": 1, "z": 2 })
  }));
`;

function run(locale) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
    encoding: "utf8",
    env: { ...process.env, LANG: locale, LC_ALL: locale },
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result.stdout.trim();
}

const english = run("en_US.UTF-8");
const swedish = run("sv_SE.UTF-8");
if (english !== swedish) {
  process.stderr.write(
    `Locale-dependent fingerprint detected:\n${english}\n${swedish}\n`,
  );
  process.exit(1);
}

process.stdout.write(`${english}\n`);
