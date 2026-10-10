# Third-party notices

Guose original code is MIT licensed: [LICENSE](LICENSE). Dependencies retain their
own licenses. A lockfile is installation identity, not a license grant.

## grill-me

- Source: [satya-janghu/agent-skills](https://github.com/satya-janghu/agent-skills).
- Pinned commit: `24b06ad34ef7b8ac46f666794e64a975bdd7fb9d`.
- MIT, Copyright (c) 2026 satya-janghu; full text:
  [grill-me.MIT.txt](docs/licenses/grill-me.MIT.txt).
- Existing unchanged project-local Skills CLI installation:
  `.agents/skills/grill-me` and `skills-lock.json`. Not Guose-authored questioning.
- No additional vendoring during release preparation.
- `npm run test:grill` checks upstream Git blob identities and lock, not host
  discovery or safety. [Installation details](docs/GRILL_INTEGRATION.md).

Runtime dependencies include commander, execa, postcss, postcss-value-parser,
TypeScript and zod. The owned demo uses React, class-variance-authority, clsx,
tailwind-merge, Tailwind and Vite. Dependency-license results are recorded in the
release report; development/test dependencies remain separately licensed.
