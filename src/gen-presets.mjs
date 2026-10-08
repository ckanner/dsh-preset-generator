#!/usr/bin/env node
/**
 * gen-presets.mjs — materialize DSH agent presets from the installed base.
 *
 * ## Why this is not part of a plugin
 *
 * DSH agent presets have no inheritance: a preset's `plugins` list is its
 * complete composition, and a patch replaces a whole entry rather than merging
 * into it. So any custom preset has to restate the base preset, and the base
 * ships inside the application and changes when DSH is upgraded.
 *
 * That job belongs to no single plugin. It started inside one, which meant a
 * plugin's script was rewriting a profile region that also serves other plugins
 * and the settings UI. Here it is a tool of its own: it reads the base, applies a
 * policy, and writes the marked region of a profile patch.
 *
 * ## The marker is load-bearing
 *
 * `BEGIN` names this file's original path, and it has to keep naming it: a
 * profile generated before this move already contains that exact string, and a
 * different one would make this script append a second block instead of
 * replacing the first.
 *
 * ## Usage
 *
 *   node src/gen-presets.mjs                 # write into the desktop profile
 *   node src/gen-presets.mjs --dry-run       # print, write nothing
 *   node src/gen-presets.mjs --out FILE      # write to FILE instead
 *   node src/gen-presets.mjs --daily-only    # refuse if the file already has heavy
 *   node src/gen-presets.mjs --asar PATH     # override the app.asar path
 *   node src/gen-presets.mjs --profile DIR   # override the profile directory
 *
 * @module dsh-preset-generator
 */

import { closeSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_ASAR =
  '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'
const BASE_PRESET = 'dsh/node_modules/@deepseek-ai/dsh-web-app/presets/ptc.patch.yml'
const DEFAULT_PROFILE = join(homedir(), '.dsh', 'profiles', 'desktop')

const BEGIN = '# >>> BEGIN generated presets (scripts/gen-presets.mjs) >>>'
const END = '# <<< END generated presets <<<'

/** The two presets this script owns. `daily` is a faithful PTC + Codex; `heavy`
 * flips the tool presentation to `both` so LCU's `js` is callable natively
 * instead of being nested inside a `run_code` program. */
const PRESETS = {
  daily: {
    id: 'daily',
    name: '日常',
    description: '日常编码：PTC 程序化工具调用 + Codex 委派',
    order: 5,
    presentation: null, // keep the base's `ptc`
    // Nothing to enable. The base ships `tool-subagent-codex` disabled, and it
    // stays that way: `dsh-subagent-codex-pro` registers its own
    // `subagent_codex` per Agent, and two rows registering that name in one
    // scope collide — the later registration throws and its tool never appears.
    enable: [],
    append: [],
  },
  heavy: {
    id: 'heavy',
    name: '重活',
    description: '超前/困难的重活：需要 Computer 或 Browser 时用',
    order: 6,
    // `both` so LCU's `js` stays callable natively: in pure `ptc` presentation
    // the model would have to nest a whole CUA program inside a run_code string.
    // No tool row is added here — the plugin is mounted at the profile root and
    // registers its tools per Agent by checking this preset's id.
    presentation: 'both',
    // Same reason as `daily`: the official Codex row stays disabled so that
    // `dsh-subagent-codex-pro` is the only provider of `subagent_codex`.
    enable: [],
    append: [],
  },
}

// ---------------------------------------------------------------------------
// Minimal asar reader (Electron's asar is a simple header + flat blob)
// ---------------------------------------------------------------------------

/**
 * Read one file out of an asar archive without Electron.
 * @param asarPath - absolute path to the `.asar` file
 * @param innerPath - slash-separated path inside the archive
 * @returns the file contents
 */
function readAsarFile(asarPath, innerPath) {
  const fd = openSync(asarPath, 'r')
  try {
    const head = Buffer.alloc(16)
    readSync(fd, head, 0, 16, 0)
    const baseOffset = 8 + head.readUInt32LE(4)
    const jsonSize = head.readUInt32LE(12)
    const json = Buffer.alloc(jsonSize)
    readSync(fd, json, 0, jsonSize, 16)
    let node = JSON.parse(json.toString('utf8'))
    for (const segment of innerPath.split('/').filter(Boolean)) {
      node = node.files?.[segment]
      if (node === undefined) throw new Error(`not in archive: ${innerPath}`)
    }
    if (node.files !== undefined) throw new Error(`is a directory: ${innerPath}`)
    const buf = Buffer.alloc(node.size)
    readSync(fd, buf, 0, node.size, baseOffset + Number(node.offset))
    return buf
  } finally {
    closeSync(fd)
  }
}

// ---------------------------------------------------------------------------
// Line surgery
// ---------------------------------------------------------------------------

/** Indentation (0-based column of the first non-space char); -1 for blank lines. */
const indentOf = (line) => (line.trim() === '' ? -1 : line.search(/\S/))

/** Index of the child row `- id: <rowId>` inside a plugin list. */
function findRow(lines, rowId) {
  const index = lines.findIndex((line) => line.trim().startsWith(`- id: ${rowId}`))
  if (index < 0) throw new Error(`plugin row not found: ${rowId}`)
  return index
}

/**
 * Iterate the direct/indirect body lines of the row starting at `start`,
 * stopping at the next row or any line dedented to the row's own level.
 */
function* body(lines, start) {
  const base = indentOf(lines[start])
  for (let i = start + 1; i < lines.length; i += 1) {
    const ind = indentOf(lines[i])
    if (ind === -1) continue
    if (ind <= base) return
    yield i
  }
}

/**
 * Remove `disabled: true` from one row, turning it on.
 * @returns a new line array
 */
function enableRow(lines, rowId) {
  const start = findRow(lines, rowId)
  for (const i of body(lines, start)) {
    if (lines[i].trim().startsWith('disabled:')) {
      return lines.filter((_, k) => k !== i)
    }
  }
  return lines // already enabled — idempotent
}

/** Rewrite `mode:` inside the `tool-presentation` row. */
function setPresentationMode(lines, mode) {
  const start = findRow(lines, 'tool-presentation')
  for (const i of body(lines, start)) {
    if (/^\s*mode:\s*\S+\s*$/.test(lines[i])) {
      const next = [...lines]
      next[i] = lines[i].replace(/mode:\s*\S+\s*$/, `mode: ${mode}`)
      return next
    }
  }
  throw new Error('tool-presentation row has no `mode:` field')
}

/** Extract the `plugins:` sub-tree (the row list) from a preset patch file. */
function extractPlugins(lines) {
  const index = lines.findIndex((line) => /^\s*plugins:\s*$/.test(line))
  if (index < 0) throw new Error('base preset has no `plugins:` key')
  const base = indentOf(lines[index])
  const out = []
  for (let i = index + 1; i < lines.length; i += 1) {
    const ind = indentOf(lines[i])
    if (ind !== -1 && ind <= base) break
    out.push(lines[i])
  }
  if (out.every((line) => line.trim() === '')) throw new Error('base `plugins:` is empty')
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop()
  return out
}

// ---------------------------------------------------------------------------
// Preset rendering
// ---------------------------------------------------------------------------

function renderPreset(spec, basePlugins) {
  const plugins = spec.enable.reduce(enableRow, [...basePlugins])
  const withMode = spec.presentation === null
    ? plugins
    : setPresentationMode(plugins, spec.presentation)
  const out = [
    `    - id: preset-${spec.id}`,
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    `        id: ${spec.id}`,
    `        name: '${spec.name}'`,
    `        description: '${spec.description}'`,
    `        order: ${spec.order}`,
    '        plugins:',
    ...withMode,
    ...spec.append,
  ]
  return out
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    // Default to the full set: this generator exists for the presets those
    // `heavy` is the preset that attaches it. Defaulting to daily-only meant a
    // routine re-run after a DSH upgrade silently deleted the preset computer
    // use depends on.
    withHeavy: true,
    out: undefined,
    asar: DEFAULT_ASAR,
    profile: DEFAULT_PROFILE,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--with-heavy') opts.withHeavy = true
    else if (arg === '--daily-only') opts.withHeavy = false
    else if (arg === '--out') opts.out = argv[++i]
    else if (arg === '--asar') opts.asar = argv[++i]
    else if (arg === '--profile') opts.profile = argv[++i]
    else throw new Error(`unknown argument: ${arg}`)
  }
  return opts
}

function buildBlock(baseLines, { withHeavy }) {
  const basePlugins = extractPlugins(baseLines)
  const specs = withHeavy ? [PRESETS.daily, PRESETS.heavy] : [PRESETS.daily]
  const lines = ['- insert:']
  for (const spec of specs) lines.push(...renderPreset(spec, basePlugins))
  return { body: lines.join('\n'), basePlugins, specs }
}

/** Replace the marked block in place, or append one. */
/**
 * Whether a top-level entry is the one this script wrote.
 *
 * The markers only say where the block lives, and the region is not exclusively
 * ours: DSH's settings UI appends its own entries there. So the entry to replace
 * is identified by what it contains — the `- insert:` shell carrying preset rows
 * — rather than by being the only thing between the markers.
 *
 * @param entry - the lines of one top-level entry.
 * @returns whether it is this script's.
 */
function isOwnEntry(entry) {
  return /^-\s+insert:\s*$/.test(entry[0]) && entry.some((line) => /^\s+- id: preset-/.test(line))
}

/**
 * Replace this script's own entry inside the region, and nothing else.
 *
 * Everything else in the region is left exactly where it is. That is the whole
 * point: entries the settings UI put there are neither moved nor re-emitted, so
 * there is nothing to collect, nothing to de-duplicate, and no way for a
 * repeated settings write to accumulate a copy per run.
 *
 * @param region - the text between the markers.
 * @param body - the entry to write, without the markers.
 * @returns the region with our entry replaced.
 */
function replaceOwnEntry(region, body) {
  const lines = region.split('\n')
  const out = []
  let replaced = false
  let i = 0
  while (i < lines.length) {
    if (!/^-\s+\S/.test(lines[i])) {
      out.push(lines[i])
      i += 1
      continue
    }
    const start = i
    i += 1
    while (i < lines.length && !/^-\s+\S/.test(lines[i])) i += 1
    const entry = lines.slice(start, i)
    if (!replaced && isOwnEntry(entry)) {
      // The entry as consumed includes the blank lines that followed it, since
      // they are not the start of another entry. They separate it from whatever
      // comes next, so they are restored — otherwise the marker that follows ends
      // up glued to the last line of the body.
      const trailing = []
      while (entry.length > 0 && entry[entry.length - 1].trim() === '') trailing.unshift(entry.pop())
      out.push(...body.split('\n'), ...trailing)
      replaced = true
      continue
    }
    out.push(...entry)
  }
  // No entry of ours inside — a hand-edited file, or a region whose block was
  // removed. Writing one is the same thing the first run does.
  if (!replaced) out.unshift(body)
  return out.join('\n')
}

function spliceBlock(text, body) {
  const begin = text.indexOf(BEGIN)
  const end = text.indexOf(END)
  if (begin >= 0 && end > begin) {
    // `region` runs from just after the BEGIN marker to just before END, so it
    // already carries the newline that ends the marker line and the one before
    // END. Adding either again would leave a blank line behind on every run.
    const region = text.slice(begin + BEGIN.length, end)
    return text.slice(0, begin)
      + BEGIN + replaceOwnEntry(region, body) + END
      + text.slice(end + END.length)
  }
  const separator = text.endsWith('\n') ? '\n' : '\n\n'
  return `${text}${separator}${BEGIN}\n${body}\n${END}\n`
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const baseLines = readAsarFile(opts.asar, BASE_PRESET).toString('utf8').split('\n')
  const { body, basePlugins, specs } = buildBlock(baseLines, opts)
  const verb = opts.dryRun ? 'would write' : 'wrote'
  const rowCount = basePlugins.filter((line) => /^\s*- id: /.test(line)).length

  if (opts.dryRun) {
    process.stdout.write(`${BEGIN}\n${body}\n${END}\n`)
  } else {
    const target = opts.out ?? join(opts.profile, 'cordis.patch.yml')
    const before = readFileSync(target, 'utf8')
    // Never delete a preset this file already had. A re-run is the documented
    // response to a DSH upgrade, and it must not be able to take away the mode a
    // user relies on as a side effect of an argument they did not pass.
    for (const preset of ['daily', 'heavy']) {
      const had = before.includes(`- id: preset-${preset}`)
      const keeps = body.includes(`- id: preset-${preset}`)
      if (had && !keeps) {
        throw new Error(
          `${target} already defines preset-${preset} and this run would remove it. `
          + 'Re-run without --daily-only to keep every preset the file has.',
        )
      }
    }
    writeFileSync(target, spliceBlock(before, body), { mode: 0o600 })
    process.stderr.write(`${verb} ${target}\n`)
  }
  process.stderr.write(
    `base: ${BASE_PRESET} (${rowCount} top-level rows)\n`
    + `presets: ${specs.map((s) => s.id).join(', ')}\n`,
  )
}

main()
