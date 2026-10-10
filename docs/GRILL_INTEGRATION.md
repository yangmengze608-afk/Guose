# grill-me integration

Upstream: [satya-janghu/agent-skills](https://github.com/satya-janghu/agent-skills).
Pinned commit: `24b06ad34ef7b8ac46f666794e64a975bdd7fb9d`; MIT,
Copyright (c) 2026 satya-janghu. [Full license](licenses/grill-me.MIT.txt).

Existing project-local unchanged upstream files are in
`.agents/skills/grill-me/{SKILL.md,README.md}`; `skills-lock.json` pins their source.
This is not Guose-authored interviewing logic. No extra vendoring is introduced.

## Fresh Codex host

Do not assume the skill is installed or auto-discovered. A source checkout already
contains the pinned installation; use a Codex host that discovers project-local
`.agents/skills`, restart/reload its skill catalog as needed. Read its actual
SKILL.md before invoking it. The CLI below verifies/reinstalls the pinned revision:

```sh
npx --yes skills@1.7.0 add https://github.com/satya-janghu/agent-skills/tree/24b06ad34ef7b8ac46f666794e64a975bdd7fb9d/skills/grill-me --agent codex --yes
npx --yes skills@1.7.0 list --agent codex --json
npm run test:grill
```

Requires network/npm/GitHub and Skills CLI 1.7.0. Do not silently use latest/update.
`/grill-me <topic>` is a **host skill invocation**, not a shell executable.
Guose does not bundle Codex or call a model API.

## What was actually validated

Pinned installation into an empty directory, CLI discovery and unchanged Git blob
identity were checked. The real native-host interview clarified the owned-demo
intent; human subsequently supplied traditionalStrength=0.3 / intensity=high and
approved the Brief. Earlier T2 missing-field notes are historical, not current.

Host automatic slash-menu discovery on arbitrary machines remains unverified.
Bytes/lock checks are not interview, approval or security proofs. Public demo helper
uses the existing sanitized session as visible draft input and asks for new
approval; it does not redo Grill or silently restore historical authorization.

Git blobs: SKILL `880871d72a6770813f5728e0978b8550ae60c47c`,
README `2748ba9a2352ef147ee33d954e6856a14d0ba430`,
LICENSE `9e62be76633f7a7ec716d4f713407ebf1c39e75f`.
