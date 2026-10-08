# dsh-preset-generator

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

## What it must not destroy

The region between the markers is also written by DSH's settings UI, which appends entries such as
`agent-preset-registry` and `subagent-model-selection-settings` there. Splicing the region deletes them silently,
taking the user's settings with it.

So entries this script did not write are:

1. **collected** from inside the region,
2. **re-emitted after** the block — which also makes the newest value win, since DSH merges by `id` and the later
   entry is applied last, and
3. **de-duplicated** against any copy already outside the region. Without this, a settings write that lands
   inside again would leave the previous run's copy behind and add another, growing the file by one entry per
   write.

## Development

```sh
npm test    # node --test; the base comes from the installed application
```

The tests run against a synthetic profile patch and skip themselves when the application is not installed, so
they are meaningful locally and still pass in CI.

## License

MIT.
