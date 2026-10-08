/**
 * The generator, against a synthetic profile patch.
 *
 * The base preset comes from the installed application, so these skip when it is
 * not there. Everything else is built here: a patch with the markers and the
 * foreign entries DSH's settings UI is known to write between them.
 *
 * The properties under test are the ones that failed in production. Splicing the
 * marked region deleted settings the UI had put there; re-emitting them without
 * de-duplicating grew the file by one entry per settings write. Both are silent —
 * nothing errors, the file just loses or accumulates rows — so they are pinned
 * here rather than left to a review.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'src', 'gen-presets.mjs')
const ASAR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'
const skip = existsSync(ASAR) ? false : 'the DeepSeek Harness application is not installed'

/** The marker this script must keep using, whatever path it now lives at. */
const BEGIN = '# >>> BEGIN generated presets (scripts/gen-presets.mjs) >>>'
const END = '# <<< END generated presets <<<'

const tempDirs = []
process.on('exit', () => {
  for (const directory of tempDirs) rmSync(directory, { recursive: true, force: true })
})

/** A profile patch with the markers, an old block, and the settings entries. */
function syntheticPatch(options = {}) {
  const directory = mkdtempSync(join(homedir(), '.dsh-preset-generator-test-'))
  tempDirs.push(directory)
  const path = join(directory, 'cordis.patch.yml')
  writeFileSync(path, [
    '- id: ui-chat',
    '  name: "@deepseek-ai/dsh-ui-chat"',
    '',
    BEGIN,
    '- insert:',
    '    - id: preset-daily',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        id: daily',
    '        plugins: []',
    // What the settings UI appends, and where it lands: between the markers,
    // after this script's own entry.
    '- id: agent-preset-registry',
    '  name: "@deepseek-ai/dsh-agent-preset-registry"',
    '  config:',
    `    default: ${options.defaultPreset ?? 'standard'}`,
    `    selectedDefault: ${options.defaultPreset ?? 'standard'}`,
    '- id: subagent-model-selection-settings',
    '  name: "@deepseek-ai/dsh-tool-subagent/model-selection-settings"',
    '  config:',
    '    enabled: false',
    '    allowedModels: []',
    END,
    '',
    '- id: ui-settings',
    '  name: "@deepseek-ai/dsh-ui-settings"',
    '',
  ].join('\n'))
  return path
}

/** Run the generator, in place, against a synthetic patch. */
function generate(path, args = []) {
  return execFileSync(process.execPath, [SCRIPT, '--out', path, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** The ids of a patch's top-level entries. */
function topLevelIds(text) {
  return text.split('\n')
    .filter((line) => /^-\s+id:\s*\S+/.test(line))
    .map((line) => /^-\s+id:\s*(\S+)/.exec(line)[1])
}

/** How many times a top-level entry with this id appears. */
function idCount(text, id) {
  return topLevelIds(text).filter((found) => found === id).length
}

/** The value of the settings entry this test file's patch carries. */
function defaultValue(text) {
  const lines = text.split('\n')
  const at = lines.findIndex((line) => /^-\s+id:\s*agent-preset-registry\s*$/.test(line))
  if (at < 0) return undefined
  // `/m`, or `^` anchors to the start of the whole slice rather than the line.
  return /^\s+default:\s*(\S+)/m.exec(lines.slice(at, at + 6).join('\n'))?.[1]
}

test('the marker still names the path profiles were generated with', () => {
  // Not cosmetic: a profile generated before this script moved already contains
  // this exact string, and a different one would make it append a second block
  // instead of replacing the first.
  const source = readFileSync(SCRIPT, 'utf8')
  assert.ok(source.includes(`const BEGIN = '${BEGIN}'`), 'the BEGIN marker must be unchanged')
  assert.ok(source.includes(`const END = '${END}'`))
})

test('a run replaces the block, keeps every other entry, and stays idempotent', { skip }, () => {
  const path = syntheticPatch()
  const before = topLevelIds(readFileSync(path, 'utf8'))
  generate(path)
  const once = readFileSync(path, 'utf8')
  const after = topLevelIds(once)

  // The `preset-daily` / `preset-heavy` rows live inside the block, so they are
  // not top-level entries of the patch. Everything else must survive.
  for (const id of before) {
    assert.ok(after.includes(id), `${id} was lost`)
  }
  assert.ok(once.includes('preset-daily') && once.includes('preset-heavy'), 'both presets are generated')

  generate(path)
  assert.equal(readFileSync(path, 'utf8'), once, 'a second run must change nothing')
})

test('the official Codex row stays disabled, as the base ships it', { skip }, () => {
  const path = syntheticPatch()
  generate(path)
  const text = readFileSync(path, 'utf8')
  // Two rows, one per preset. Enabling either would collide with the provider
  // that registers `subagent_codex` itself.
  const rows = text.split('\n').filter((line) => /^\s+- id: tool-subagent-codex\s*$/.test(line))
  assert.equal(rows.length, 2, 'one Codex row per preset')
  for (const row of rows) {
    const at = text.indexOf(row)
    assert.match(text.slice(at, at + 200), /disabled: true/, 'the Codex row must stay disabled')
  }
})

test('settings entries are left exactly where the settings UI put them', { skip }, () => {
  // The whole class of bug this replaces came from moving them: a run relocated
  // them out of the region, the next settings write landed inside again, and each
  // run left another copy behind. Replacing only this script's own entry means
  // there is nothing to move, so there is nothing to accumulate.
  const path = syntheticPatch()
  generate(path)
  const once = readFileSync(path, 'utf8')
  const region = once.slice(once.indexOf(BEGIN), once.indexOf(END))

  assert.ok(region.includes('id: agent-preset-registry'), 'left inside the region')
  assert.ok(region.includes('id: subagent-model-selection-settings'), 'left inside the region')
  assert.equal(idCount(once, 'agent-preset-registry'), 1)

  // A second run must not add another, and must not move it out either.
  generate(path)
  const twice = readFileSync(path, 'utf8')
  assert.equal(twice, once)
  assert.equal(idCount(twice, 'agent-preset-registry'), 1)
  assert.equal(defaultValue(twice), 'standard', 'the value it had is the value it keeps')
})

test('a value the settings UI changed is not overwritten', { skip }, () => {
  const path = syntheticPatch()
  generate(path)
  const lines = readFileSync(path, 'utf8').split('\n')
  const at = lines.findIndex((line) => /^\s+default: standard\s*$/.test(line))
  assert.ok(at > 0, 'the settings entry is there to change')
  lines[at] = '    default: heavy'
  writeFileSync(path, lines.join('\n'))

  generate(path)
  // The entry is not ours, so its value is none of our business — including when
  // it is a value we would not have written.
  assert.equal(defaultValue(readFileSync(path, 'utf8')), 'heavy')
})

test('--daily-only refuses to drop a preset the file already defines', { skip }, () => {
  const path = syntheticPatch()
  generate(path)
  assert.throws(
    () => generate(path, ['--daily-only']),
    (error) => /heavy/.test(String(error.stderr ?? '') + String(error.message ?? '')),
  )
  assert.ok(readFileSync(path, 'utf8').includes('preset-heavy'), 'the preset is still there')
})
