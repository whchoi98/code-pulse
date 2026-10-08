# Code Pulse contributor guidance

Read README.md, docs/runbook.md and the relevant parts of docs/verification.md before changing behavior.

## Project and entrypoints

Code Pulse publishes Korean explanations of official Claude Code, Codex and Kiro changes. The public site is `https://code-pulse.whchoi.net`.

| Area | Entrypoints and guidance |
| --- | --- |
| Browser | `src/client/main.tsx`, `src/client/App.tsx`; filters, saved articles, read state and Markdown export stay in the browser |
| HTTP and RSS | `src/server/index.ts`, `src/server/app.ts`, `src/server/rss.ts`; see `docs/reference/api.md` |
| Visitor counts | `src/server/presence.ts`, `src/server/presence-store.ts`, `src/client/presence.ts` |
| Collection | `src/collector/run.ts`, `src/collector/engine.ts`, `src/collector/sources.ts`, `src/collector/explanation.ts` |
| Complete changes | `src/collector/change-items.ts`, `src/collector/full-changes.ts`, `tools/backfill-full-changes.ts` |
| Persistence | `src/collector/store.ts`; local files or conditional S3 writes |
| Shared contracts | `src/shared/types.ts`, `src/shared/app-release.json` |
| Infrastructure | `infra/bin/app.ts`, `infra/lib/stack.ts`, `Dockerfile` |
| Documentation | `docs/README.md`, `docs/architecture.md`, `docs/onboarding.md`, `CONTRIBUTING.md` |

Use source files as implementation evidence. `dist/`, `cdk.out/`, `node_modules/` and local `data/` are generated or runtime material. Dated plans, progress notes and review reports describe the state when they were written.

## Scope and data

- Work only in this project. Reference applications such as Robot Atlas are read-only examples; do not read their `.env` files or change their resources.
- Keep the existing VPC, subnets, NAT and routing. The web path is CloudFront, its prefix-list security group, ALB and private Fargate.
- Collect official Claude Code, Codex and Kiro records from 2026-01-01 through the actual collection time. Keep publication dates separate from checks and editing times.
- Preserve stable IDs and previous data when a source fails. Do not invent publication dates, mark partial history complete, or publish preview releases as stable.
- Keep a complete source-item inventory alongside the short overview. Do not select only important changes or truncate source bodies. Full completion requires one validated Korean item for every source ID, with the current source hash, model and generation format.
- Keep full-change source hashes and model identifiers private. Public responses expose only the ordered Korean items, count, state and editing metadata. Preserve inline code, compound conditions and alternative outcomes.
- Use Claude Haiku 5.5 for both explanation generation and Korean editing. Keep evidence validation, scoped background material and bounded generation.
- Polish Korean prose with the available Korean editing skills. Do not use em dashes or middle dots in authored Korean; preserve code, identifiers and direct source quotes.
- Use the official local product logos and preserve their provenance in public/brand/SOURCES.md.
- Visitor counts come from the server and persistent storage. Do not fabricate counts or store IP addresses or browser fingerprints.

## Version and release synchronization

- `package.json.version` is authoritative. The initial application version is 1.0.0.
- After the initial release, advance minor for compatible user-facing features, patch for compatible fixes, and major for incompatible changes.
- For a version change, update the manifest and the root version fields in package-lock.json together. `npm version <version> --no-git-tag-version` can prepare those files without creating a tag.
- Add the matching newest entry to `src/shared/app-release.json`, keeping English and Korean meanings aligned. Use an evidenced or explicitly planned date, and preserve older release history.
- Run `npm run release:sync` to update CHANGELOG.md, README's version block and docs/releases. Run `npm run release:check` before building, committing or deploying.
- The footer reads the build version from the manifest. Do not hardcode a second version in UI code.
- A source version and a deployed application do not prove a Git tag or hosted release exists. When publishing an authorized release, the tag must be `v<package version>` and the hosted notes must use the generated release file.
- Never create, move or overwrite a remote tag or publish a hosted release without authorization for that destination. Reuse authorization already given in the current session.

## Verification and operations

Use Node 22 or newer. Check changed behavior with `npm test`, type checking and the relevant browser tests. Source-reader tests use recorded official structures; live AWS and public-browser checks are separate evidence.

Install dependencies with `npm ci`. `npm run build` builds the browser, server and collector; `npm start` serves the build. `npm run dev` and `npm run dev:client` are separate backend and Vite processes. Follow `docs/onboarding.md` for local environment settings and the Vite RSS limitation.

Use `npm run typecheck`, `npm test` and `npm run test:browser` for implementation changes under the rule above. `npm run synth -- --no-lookups` validates infrastructure without VPC lookups. A declared command is not evidence that a check passed.

For documentation-only changes, check affected links, commands, facts and version synchronization. Reuse prior implementation results only after confirming that their source, test, dependency and configuration inputs still match. Do not rerun application suites solely because prose changed. Changes to generators, executable examples or contributor instructions need their relevant checks. Report newly executed checks and reused results separately.

The collector and server have different privileges. Only the collector may invoke the explanation model or write published content; the web role may update its separate visitor table.

Keep S3 conditional writes, generation checkpoints, first-visit deduplication and explicit unavailable states. Verify real task completion and the public HTTPS endpoint after deployment. Never expose origin header values, signing secrets or credentials in logs or reports.

Full-history generation runs in an explicitly selected local FileStore through `tools/backfill-full-changes.ts`. The local migration permits up to 12 workers; scheduled collection retains its separate 1–6 limit. Validate `tools/verify-full-changes.ts` before conditional publication. Reviewed wording corrections use source-bound item IDs; do not rewrite publication dates or unrelated records.

## Documentation maintenance

Keep `docs/README.md` navigable. Update the API reference when routes or response contracts change, architecture guidance when component responsibilities change, and onboarding or the runbook when commands and configuration change.

Preserve the existing Korean README and historical report layouts. New public guides use English followed by Korean with matching language navigation and technical values. Apply the Korean prose rules above to changed text.

CHANGELOG.md, `docs/releases/` and the README version block are generated by `tools/release-docs.mjs`; update their release source instead of editing generated history. Documentation preparation alone does not bump the application version.

The repository is `https://github.com/whchoi98/code-pulse.git`, with `main` as the primary branch. Confirm the actual worktree, branch and remote before Git operations. Do not invent a license, contact address, tag or hosted release. Use `CONTRIBUTING.md` for the change handoff.
