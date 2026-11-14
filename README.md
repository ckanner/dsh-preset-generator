# dsh-preset-generator

English | [中文](docs/README.zh.md)

Materialize [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) agent presets from the base preset
that ships inside the application.

```sh
node src/gen-presets.mjs              # write into ~/.dsh/profiles/desktop
node src/gen-presets.mjs --dry-run    # print the block, write nothing
node src/gen-presets.mjs --out FILE   # write somewhere else
node src/gen-presets.mjs --daily-only # refuse if the file already defines heavy
```

## Why this exists

DSH agent presets have **no inheritance**. A preset's `plugins` list is its complete composition, and a patch
replaces a whole entry rather than merging into it. So a custom preset has to restate the base preset — and the
base ships inside the application and changes when DSH is upgraded, which makes hand-copying it a losing game.

This writes that restatement: it reads the base from the installed `app.asar`, applies a policy, and writes the
marked region of a profile's `cordis.patch.yml`.

It is deliberately **not part of a plugin**. The presets it generates serve more than one plugin, and the region
it writes is also written by DSH's own settings UI. A tool that belongs to one plugin ends up rewriting a file
that several parties own; this one belongs to nobody in particular, which is the honest description.

## The marker is load-bearing

The `BEGIN` marker contains the path this file lived at when the first profiles were generated. It has to keep
containing that path: a profile generated before the move already has the exact string, and a different one would
make this script **append a second block** instead of replacing the first.

## What it writes

| Preset | Base | Policy |
|---|---|---|
| `daily` (日常) | the shipped `ptc` preset | PTC executor; daily coding label |
| `heavy` (重活) | the same `ptc` preset | the same executor policy; heavy work label |

Both presets use PTC. LCU exposes its ChatGPT-app Computer/Browser runtime through the PTC `cua`
bridge: `cua.getApp`, `cua.getTab`, screenshots and handle methods all run through `run_code`, so
`heavy` no longer opts out of PTC for a directly-callable native `js` tool.
The generated plugin lists currently have the same policy. GUI availability and
Codex delegation depend on separately mounted providers and their allowlists;
the name `heavy` does not itself grant either capability.

The official Codex tool is no longer a per-preset row: as of DSH 0.2.1 the `@deepseek-ai/dsh-subagent-codex`
bundle contributes a **global** `subagent_codex` tool, and a separate provider (`dsh-subagent-codex-pro`)
registers its own same-named tool per Agent for these presets, shadowing the global one. Two registrations in
*one* scope still collide, so nothing may enable a same-name `tool-subagent` row beside that provider.

## What it must not touch

The region between the markers is **not exclusively this script's**. DSH's settings UI appends its own entries
there — `agent-preset-registry` and `subagent-model-selection-settings` have both landed between the markers —
and so may anything else that writes a profile patch.

So a run replaces **only its own entry**: the `- insert:` shell carrying the preset rows. Everything else in the
region is left exactly where it is, byte for byte.

That is a stronger property than handling them carefully. An earlier version replaced the whole region, then
re-emitted the entries it had not written after the block, then de-duplicated them against copies already
outside it — three mechanisms, each fixing a failure of the one before:

| Approach | What went wrong |
|---|---|
| Replace the region | Deleted the settings entries silently |
| Re-emit them after the block | The next settings write landed inside again, and the run left another copy each time |
| De-duplicate by id | Correct, but ~60 lines that exist only to undo a move that should not happen |

Replacing one entry has none of those failure modes, because nothing is ever moved: there is no copy to
de-duplicate and nothing to accumulate. Entries that are not ours are not read, not rewritten, and not
relocated — including values this script would not have chosen.

## Development

```sh
npm test    # portable CLI/ASAR fixtures and SDK composition contracts
```

The tests use a synthetic ASAR and profile patch, so preservation, idempotency,
legacy selectors and direct executor rows run on CI without a desktop app. They
do not certify a user's installed application or call a model.

## SDK composition API

The package also exports a pure ESM API. Importing it performs no file access,
runtime launch, model call, or desktop-profile write. Desktop generation and SDK
composition share `src/policy.mjs`; SDK callers apply a separate profile patch.

```js
import {
  inspectPtcBundle, createSdkPtcComposition, validateSdkPtcAdmission,
} from 'dsh-preset-generator'

// Values read by the caller from the exact installed bundle, not a version guess.
const evidence = inspectPtcBundle({ packageJson, files, sourceRevision })
const composition = createSdkPtcComposition({
  runtimeProfile: 'flywheel-sdk', preset: 'heavy', baseRows, ptcEvidence: evidence,
})
// Apply composition.overlay via the SDK host's profile loader, then run a probe.
const admission = validateSdkPtcAdmission(composition, observed, { requireImages: true })
```

`baseRows` are effective JSON plugin rows with unique ids, after the host has
resolved its configuration; nested patch `insert` directives are rejected. The
overlay disables the native executor, enables PTC, and sets
`tool-fs.applyPatch: false`, preserving supplied fs/PTC configuration. A known
legacy `tool-presentation` row is disabled too. `desktop` is refused as an SDK
profile. Absent `baseRows`, the result is the official minimal SDK PTC patch; it
does not claim to have inspected custom configuration.

The returned `digest` binds the profile, policy, base, overlay and bundle
evidence. `compositionDigest(value)` hashes canonical JSON; files are supplied as
relative paths mapped to their exact text. `inspectPtcBundle` returns per-file
hashes, actual manifest exports and descriptive source clues. It always leaves
`outputContract: 'unknown'`: release rc.3 and later master can share
`0.2.2-rc.3` while changing exports and image/output semantics. Source identity
must accompany the version. See the [release PTC manifest](https://github.com/deepseek-ai/deepseek-harness/blob/38a6a5c965aa99ab525161efb7cc5cf1fe62fced/packages/core/tool-executor-ptc/package.json)
and [later manifest](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/core/tool-executor-ptc/package.json).

Admission requires observed `compositionDigest`, `runtimeProfile`,
`executor: 'ptc'`, `activeExecutors: ['ptc']`, `tools` containing `run_code`,
`probeStatus: 'passed'`, and a verified `outputContract` of
`deferred-context-v1` or `inspect-image-v1`. Supplied bundle evidence requires a
matching observed `bundleDigest`. `requireImages` additionally requires
`imageProbeStatus: 'passed'`; an absent image probe never advertises image
support. The worker obtains these facts from its actual runtime. This library
only checks the receipt, hashes all JSON observations, and rejects a composition
modified after generation. It does not authenticate the receipt transport.

`provenance.kind` is `sdk-global-composition` and `namedPresetMounted` is always
false: sharing daily/heavy policy is not a named-preset SDK RPC. GUI and
delegation remain separate grants. A consumer adding permission or provider
overlays must also bind the complete final configuration in its own digest.
Executor image probing and delivery through the provider are separate checks.

## License

MIT.
