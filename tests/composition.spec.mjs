import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSdkPtcComposition, inspectPtcBundle, validateSdkPtcAdmission, compositionDigest, presetPolicy } from '../src/composition.mjs'

const manifest = { name: '@deepseek-ai/dsh-tool-executor-ptc', version: '0.2.2-rc.3', exports: { '.': './lib/index.js' } }
const release = inspectPtcBundle({ packageJson: manifest, files: { 'lib/index.js': 'deferredContext(output)' } })
const current = inspectPtcBundle({ packageJson: { ...manifest, exports: { ...manifest.exports, './run-code': './lib/run-code.js' } },
  files: { 'lib/index.js': 'inspect(new PtcImage(path))', 'lib/run-code.js': 'export const createRunCodeTool = factory' }, sourceRevision: 'source-master' })
function observation(composition, overrides = {}) {
  return { compositionDigest: composition.digest, runtimeProfile: 'sdk', executor: 'ptc', activeExecutors: ['ptc'],
    tools: ['run_code'], outputContract: 'inspect-image-v1', probeStatus: 'passed',
    bundleDigest: composition.provenance.bundleDigest, ...overrides }
}

test('daily/heavy share the executor policy without granting GUI or delegation', () => {
  const daily = createSdkPtcComposition({ preset: 'daily' })
  const heavy = createSdkPtcComposition({ preset: 'heavy' })
  assert.deepEqual(daily.overlay, heavy.overlay)
  assert.equal(heavy.provenance.namedPresetMounted, false)
  assert.equal(heavy.requirements.guiGranted, false)
  assert.equal(heavy.requirements.delegationGranted, false)
  const policy = presetPolicy('heavy')
  policy.presentation = 'native'
  assert.equal(presetPolicy('heavy').presentation, 'ptc')
  assert.throws(() => presetPolicy('__proto__'), /Unknown/)
})

test('SDK patches preserve known config and remove an obsolete selector without mutating input', () => {
  const baseRows = [{ id: 'tool-presentation', config: { mode: 'native' } },
    { id: 'tool-fs', config: { customRoot: 'repository', applyPatch: true } },
    { id: 'tool-executor-ptc', disabled: true, config: { maxParallelSubCalls: 2 } }]
  const before = structuredClone(baseRows)
  const value = createSdkPtcComposition({ baseRows })
  assert.deepEqual(value.overlay, [
    { id: 'tool-presentation', disabled: true }, { id: 'tool-executor-native', disabled: true },
    { id: 'tool-executor-ptc', disabled: false, config: { maxParallelSubCalls: 2 } },
    { id: 'tool-fs', config: { customRoot: 'repository', applyPatch: false } },
  ])
  assert.deepEqual(baseRows, before)
  value.overlay[2].config.maxParallelSubCalls = 8
  assert.deepEqual(baseRows, before)
})

test('different same-version bundles get distinct identities but neither proves runtime support', () => {
  assert.equal(release.packageVersion, current.packageVersion)
  assert.notEqual(release.bundleDigest, current.bundleDigest)
  assert.equal(release.outputContract, 'unknown')
  assert.equal(current.outputContract, 'unknown')
  assert.equal(current.clues.privateProgramExport, true)
  const composition = createSdkPtcComposition({ ptcEvidence: current })
  assert.equal(validateSdkPtcAdmission(composition, {}).eligible, false)
})

test('source, base config and export changes invalidate composition even under the same name', () => {
  const original = createSdkPtcComposition({ ptcEvidence: release })
  assert.notEqual(original.digest, createSdkPtcComposition({ ptcEvidence: current }).digest)
  assert.notEqual(original.digest, createSdkPtcComposition({ ptcEvidence: release, baseRows: [{ id: 'tool-fs', config: { max: 2 } }] }).digest)
  assert.equal(compositionDigest({ x: 1, y: 2 }), compositionDigest({ y: 2, x: 1 }))
  assert.throws(() => compositionDigest({ x: undefined }), /JSON values/)
})

test('admission requires an exclusive executor, matching source and observed output protocol', () => {
  const composition = createSdkPtcComposition({ ptcEvidence: current })
  const good = observation(composition)
  assert.equal(validateSdkPtcAdmission(composition, good).eligible, true)
  assert.equal(validateSdkPtcAdmission(composition, good).imagesVerified, false)
  for (const [overrides, failure] of [
    [{ compositionDigest: 'other' }, 'composition-digest-mismatch'],
    [{ runtimeProfile: 'desktop' }, 'runtime-profile-mismatch'],
    [{ activeExecutors: ['native', 'ptc'] }, 'executor-not-exclusive-ptc'],
    [{ executor: 'native' }, 'executor-not-exclusive-ptc'],
    [{ tools: ['cua'] }, 'run-code-not-registered'],
    [{ outputContract: 'unknown' }, 'output-contract-unverified'],
    [{ probeStatus: 'not-run' }, 'runtime-probe-not-passed'],
    [{ bundleDigest: release.bundleDigest }, 'bundle-digest-mismatch'],
  ]) {
    const result = validateSdkPtcAdmission(composition, observation(composition, overrides))
    assert.equal(result.eligible, false)
    assert.ok(result.failures.includes(failure), failure)
  }
})

test('text evidence cannot satisfy an image-required route, including after failed probing', () => {
  const composition = createSdkPtcComposition()
  assert.equal(validateSdkPtcAdmission(composition, observation(composition), { requireImages: true }).eligible, false)
  assert.equal(validateSdkPtcAdmission(composition, observation(composition, { imageProbeStatus: 'failed' }), { requireImages: true }).eligible, false)
  const good = validateSdkPtcAdmission(composition, observation(composition, { imageProbeStatus: 'passed' }), { requireImages: true })
  assert.equal(good.eligible, true)
  assert.equal(good.imagesVerified, true)
})

test('a modified overlay cannot reuse an earlier composition digest', () => {
  const composition = createSdkPtcComposition()
  const observed = observation(composition)
  composition.overlay[0].disabled = false
  assert.throws(() => validateSdkPtcAdmission(composition, observed), /changed after generation/)
})

test('invalid runtime and source inputs fail without executing or reading anything', () => {
  for (const runtimeProfile of ['desktop', '', '../desktop', '--profile']) {
    assert.throws(() => createSdkPtcComposition({ runtimeProfile }), /SDK runtime/)
  }
  assert.throws(() => createSdkPtcComposition({ baseRows: [{ id: 'a' }, { id: 'a' }] }), /unique/)
  assert.throws(() => createSdkPtcComposition({ baseRows: [{ insert: [] }] }), /plugin ids/)
  assert.throws(() => createSdkPtcComposition({ baseRows: [{ id: 'tool-fs', config: 'bad' }] }), /config/)
  assert.throws(() => inspectPtcBundle({ packageJson: manifest, files: { '../outside': 'text' } }), /relative/)
  assert.throws(() => inspectPtcBundle({ packageJson: { ...manifest, name: 'other' }, files: { 'lib/a.js': '' } }), /actual/)
  assert.throws(() => createSdkPtcComposition({ ptcEvidence: { version: 1, kind: 'static-bundle', bundleDigest: 'no' } }), /inspectPtcBundle/)
})
