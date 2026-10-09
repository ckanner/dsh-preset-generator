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
| `daily` (日常) | the shipped `ptc` preset | plugin rows, Codex delegation via a separate provider |
| `heavy` (重活) | the same, with `tool-presentation: both` | everything above, plus computer use |

`tool-presentation: both` is deliberate: in pure `ptc` presentation the model only sees `run_code`, so a
directly-callable tool would have to be nested as a JavaScript string inside another JavaScript program.

The official `tool-subagent-codex` row stays **disabled** — as the base ships it. A separate provider registers
its own `subagent_codex` per Agent, and two rows registering that name in one scope collide: the later
registration throws and its tool never appears.

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
npm test    # node --test; the base comes from the installed application
```

The tests run against a synthetic profile patch and skip themselves when the application is not installed, so
they are meaningful locally and still pass in CI.

## License

MIT.
