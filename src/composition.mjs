/** Pure SDK composition and observation checks; importing this module performs no I/O. */
import { createHash } from 'node:crypto'
import { presetPolicy } from './policy.mjs'

export { PRESETS, presetPolicy } from './policy.mjs'
export const COMPOSITION_PROTOCOL = 1
const CONTRACTS = new Set(['deferred-context-v1', 'inspect-image-v1'])
const record = value => typeof value === 'object' && value !== null && !Array.isArray(value)

function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(canonical)
  if (!record(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError('Composition inputs must contain only JSON values')
  }
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
}

/** Stable content identity, independent of object property insertion order. */
export function compositionDigest(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

function identityOf(composition) {
  return { version: composition.version, runtimeProfile: composition.runtimeProfile,
    presetPolicy: composition.presetPolicy, overlay: composition.overlay,
    provenance: composition.provenance, requirements: composition.requirements }
}

/**
 * Inspect caller-supplied, actually read bundle files. This is static provenance,
 * never proof that an executor ran or that a model received an image.
 * Versions alone deliberately cannot select the output protocol.
 */
export function inspectPtcBundle({ packageJson, files, sourceRevision } = {}) {
  if (!record(packageJson) || packageJson.name !== '@deepseek-ai/dsh-tool-executor-ptc'
    || typeof packageJson.version !== 'string' || !packageJson.version) {
    throw new TypeError('Expected the actual dsh-tool-executor-ptc package manifest')
  }
  if (!record(files) || !Object.keys(files).length || Object.entries(files).some(([name, value]) =>
    !name || name.startsWith('/') || name.split('/').includes('..') || typeof value !== 'string')) {
    throw new TypeError('Supply nonempty relative bundle filenames and their exact text')
  }
  if (sourceRevision !== undefined && (typeof sourceRevision !== 'string' || !sourceRevision)) {
    throw new TypeError('sourceRevision must be a nonempty source identity')
  }
  const exports = record(packageJson.exports) ? structuredClone(packageJson.exports) : {}
  const joined = Object.values(files).join('\n')
  const inspectImage = /\binspect\b/.test(joined) && /\bPtcImage\b|\bImage\b/.test(joined)
  const deferred = /deferredContext|deferred context/i.test(joined)
  const clues = {
    privateProgramExport: Object.hasOwn(exports, './run-code'),
    inspectImage: inspectImage,
    deferredContext: deferred,
  }
  return {
    version: COMPOSITION_PROTOCOL, kind: 'static-bundle',
    package: packageJson.name, packageVersion: packageJson.version,
    bundleDigest: compositionDigest({ packageJson, files }),
    files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))
      .map(([name, content]) => [name, createHash('sha256').update(content).digest('hex')])),
    exports, clues,
    // Clues are descriptive: an unknown or misleading README cannot certify behavior.
    outputContract: 'unknown',
    ...(sourceRevision === undefined ? {} : { sourceRevision }),
  }
}

/**
 * Produce an SDK-only patch. baseRows, when supplied, are the effective rows
 * obtained through the host loader, not raw nested insert directives. Cordis
 * replaces config values, so preserve unrelated fs/executor config explicitly.
 * This does not mount a named Agent Preset, enable children, or grant GUI access.
 */
export function createSdkPtcComposition({ runtimeProfile = 'sdk', preset = 'heavy', baseRows = [], ptcEvidence } = {}) {
  if (typeof runtimeProfile !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(runtimeProfile)
    || runtimeProfile === 'desktop') throw new TypeError('A non-desktop SDK runtime profile is required')
  const policy = presetPolicy(preset)
  if (!Array.isArray(baseRows)) throw new TypeError('baseRows must be effective plugin rows')
  const rows = new Map()
  for (const row of baseRows) {
    canonical(row)
    if (!record(row) || typeof row.id !== 'string' || !row.id || rows.has(row.id)
      || Object.hasOwn(row, 'insert')) throw new TypeError('baseRows require unique plugin ids, not patch directives')
    rows.set(row.id, row)
  }
  if (ptcEvidence !== undefined && (!record(ptcEvidence) || ptcEvidence.version !== COMPOSITION_PROTOCOL
    || ptcEvidence.kind !== 'static-bundle' || !/^[a-f0-9]{64}$/.test(ptcEvidence.bundleDigest))) {
    throw new TypeError('ptcEvidence must be an inspectPtcBundle result')
  }
  const configFor = id => {
    const config = rows.get(id)?.config
    if (config !== undefined && !record(config)) throw new TypeError(`${id}.config must be an object`)
    return structuredClone(config ?? {})
  }
  const overlay = [
    ...(rows.has('tool-presentation') ? [{ id: 'tool-presentation', disabled: true }] : []),
    { id: 'tool-executor-native', disabled: true },
    { id: 'tool-executor-ptc', disabled: false, ...(rows.has('tool-executor-ptc') ? { config: configFor('tool-executor-ptc') } : {}) },
    { id: 'tool-fs', config: { ...configFor('tool-fs'), applyPatch: false } },
  ]
  const composition = {
    version: COMPOSITION_PROTOCOL, runtimeProfile, presetPolicy: policy.id,
    overlay,
    provenance: {
      kind: 'sdk-global-composition', baseDigest: compositionDigest(baseRows),
      bundleDigest: ptcEvidence?.bundleDigest ?? null,
      staticEvidence: ptcEvidence === undefined ? null : structuredClone(ptcEvidence),
      namedPresetMounted: false,
    },
    requirements: {
      executor: 'ptc', tools: ['run_code'], outputContract: 'observed-runtime',
      guiGranted: false, delegationGranted: false,
    },
  }
  return { ...composition, digest: compositionDigest(identityOf(composition)) }
}

/**
 * Validate facts supplied by the owning worker after its real runtime probe.
 * No subprocess, model, tool or GUI action is performed here. This validator is
 * not an attestation transport: its caller must authenticate/correlate the probe.
 */
export function validateSdkPtcAdmission(composition, observed, { requireImages = false } = {}) {
  const failures = []
  if (!record(composition) || composition.version !== COMPOSITION_PROTOCOL
    || !/^[a-f0-9]{64}$/.test(composition.digest ?? '')) throw new TypeError('Invalid composition')
  if (compositionDigest(identityOf(composition)) !== composition.digest) throw new TypeError('Composition changed after generation')
  if (!record(observed)) observed = {}
  if (observed.compositionDigest !== composition.digest) failures.push('composition-digest-mismatch')
  if (observed.runtimeProfile !== composition.runtimeProfile) failures.push('runtime-profile-mismatch')
  if (observed.executor !== 'ptc' || !Array.isArray(observed.activeExecutors)
    || observed.activeExecutors.length !== 1 || observed.activeExecutors[0] !== 'ptc') failures.push('executor-not-exclusive-ptc')
  if (!Array.isArray(observed.tools) || !observed.tools.includes('run_code')) failures.push('run-code-not-registered')
  if (!CONTRACTS.has(observed.outputContract)) failures.push('output-contract-unverified')
  if (observed.probeStatus !== 'passed') failures.push('runtime-probe-not-passed')
  if (composition.provenance.bundleDigest !== null && observed.bundleDigest !== composition.provenance.bundleDigest) {
    failures.push('bundle-digest-mismatch')
  }
  if (requireImages && observed.imageProbeStatus !== 'passed') failures.push('image-contract-unverified')
  return {
    version: COMPOSITION_PROTOCOL, eligible: failures.length === 0, failures,
    compositionDigest: composition.digest,
    observedDigest: compositionDigest(observed),
    // Absent optional image evidence never turns into a positive capability.
    imagesVerified: failures.length === 0 && observed.imageProbeStatus === 'passed',
    namedPresetMounted: false,
  }
}
