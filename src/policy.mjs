/** Shared desktop and SDK intent. Names describe use, not separate GUI grants. */
export const PRESETS = Object.freeze({
  daily: Object.freeze({
    id: 'daily', name: '日常', description: '日常编码：PTC 程序化工具调用 + Codex 委派',
    order: 5, presentation: 'ptc', enable: Object.freeze([]), append: Object.freeze([]),
  }),
  heavy: Object.freeze({
    id: 'heavy', name: '重活', description: '重活：PTC Computer/Browser CUA + Codex 委派',
    order: 6, presentation: 'ptc', enable: Object.freeze([]), append: Object.freeze([]),
  }),
})

/** Return a detached policy; callers cannot alter future generated presets. */
export function presetPolicy(id) {
  if (!Object.hasOwn(PRESETS, id)) throw new TypeError(`Unknown managed preset: ${String(id)}`)
  return structuredClone(PRESETS[id])
}
