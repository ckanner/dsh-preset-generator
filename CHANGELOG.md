# Changelog

## 0.1.0

First release, as a project of its own.

**Moved out of `dsh-plugin-lcu`.** It generates presets that serve more than one plugin, and the region it writes
is also written by DSH's settings UI, so it does not belong to any one plugin — least of all one whose script was
rewriting a profile region shared with settings it does not own. The move is behaviour-preserving: generating
from the same profile with both produced byte-identical output.

**The marker still names the old path.** `BEGIN` contains `scripts/gen-presets.mjs` on purpose: a profile
generated before the move already has that exact string, and a different one would make the script append a
second block instead of replacing the first.

**Replaces only its own entry.** The region between the markers is not exclusively this script's — the settings
UI appends `agent-preset-registry` and `subagent-model-selection-settings` there. Splicing the whole region
deleted them; re-emitting them after the block left another copy behind on every later settings write. A run now
replaces the single `- insert:` entry it wrote and leaves everything else byte for byte where it is, so there is
nothing to move and nothing to accumulate.
