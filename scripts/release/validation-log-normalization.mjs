import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { TextDecoder } from 'node:util'

const utf8Decoder = new TextDecoder('utf-8', { fatal: true })
const PLACEHOLDER_PATTERN = /^<[a-z][a-z0-9-]*>$/u
const SUPPORTED_PLACEHOLDERS = new Set([
  '<execution-root>',
  '<gate-staging-root>',
  '<home>',
  '<karel-candidate>',
  '<karel-candidate-state>',
  '<repository-root>',
  '<web-artifact-manifest>',
  '<web-candidate>',
  '<web-candidate-state>',
  '<workspace-root>',
])
const TERMINAL_OSC_PATTERN = new RegExp(
  String.raw`\u001b\][^\u0007]*(?:\u0007|\u001b\\)`,
  'gu',
)
const TERMINAL_CSI_PATTERN = new RegExp(
  String.raw`\u001b\[[0-?]*[ -/]*[@-~]`,
  'gu',
)
const UNSAFE_LOCAL_PATH_PATTERNS = Object.freeze([
  /\/Users\//u,
  /\/home\//u,
  /\/root\//u,
  /\/private\/tmp\//u,
  /\/private\/var\//u,
  /\/var\/folders\//u,
  /\/tmp\//u,
  /\/Volumes\//u,
  /[A-Za-z]:[\\/]Users[\\/]/u,
  /[A-Za-z]:(?:\\\\)+Users(?:\\\\)+/u,
  /(^|[\s"'`(=])[A-Za-z]:[\\/]/mu,
  /\\\\[^\\\r\n]+\\[^\\\r\n]+/u,
  /(^|[\s"'`(=])~[\\/]/mu,
  /(^|[\s"'`(=])file:(?!(?:\/\/)?<[a-z][a-z0-9-]*>)/imu,
  /(?:%2f|%5c)(?:Users|home|root|tmp|Volumes)(?:%2f|%5c)/iu,
  /(?:%2f|%5c)private(?:%2f|%5c)tmp(?:%2f|%5c)/iu,
  /(?:%2f|%5c)private(?:%2f|%5c)var(?:%2f|%5c)/iu,
  /(?:%2f|%5c)var(?:%2f|%5c)folders(?:%2f|%5c)/iu,
  /%(?:2f|5c)/iu,
])

function inspectableText(text) {
  return text
    .replace(TERMINAL_OSC_PATTERN, '')
    .replace(TERMINAL_CSI_PATTERN, '')
    .replaceAll('\\/', '/')
}

function assertReplacement(replacement, index) {
  if (
    replacement === null
    || typeof replacement !== 'object'
    || Array.isArray(replacement)
    || typeof replacement.value !== 'string'
    || !path.isAbsolute(replacement.value)
    || replacement.value === path.parse(replacement.value).root
  ) {
    throw new TypeError(
      `Validation log replacement ${String(index)} must name a bounded absolute path`,
    )
  }
  if (!PLACEHOLDER_PATTERN.test(replacement.placeholder)) {
    throw new TypeError(
      `Validation log replacement ${String(index)} has an invalid placeholder`,
    )
  }
}

function orderedReplacements(replacements) {
  if (!Array.isArray(replacements)) {
    throw new TypeError('Validation log replacements must be an array')
  }
  const byValue = new Map()
  const add = (value, placeholder) => {
    const existing = byValue.get(value)
    if (existing && existing !== placeholder) {
      throw new TypeError('Validation log replacement paths must have one placeholder')
    }
    byValue.set(value, placeholder)
  }
  replacements.forEach((replacement, index) => {
    assertReplacement(replacement, index)
    add(replacement.value, replacement.placeholder)
    add(replacement.value.replaceAll('/', '\\/'), replacement.placeholder)
    const fileURL = pathToFileURL(replacement.value).href.replace(/\/$/u, '')
    add(fileURL, `file:${replacement.placeholder}`)
    add(fileURL.replaceAll('/', '\\/'), `file:${replacement.placeholder}`)
  })
  return [...byValue].sort(([left], [right]) => right.length - left.length)
}

function isPathBoundaryBefore(character) {
  return character === undefined || !/[A-Za-z0-9._~\\/-]/u.test(character)
}

function isPathBoundaryAfter(character) {
  return character === undefined
    || /\s/u.test(character)
    || `"'\`,:;?()[]{}<>\\/`.includes(character)
    || character.charCodeAt(0) === 0x1b
}

function replaceBoundedPath(text, value, placeholder) {
  let cursor = 0
  let output = ''
  while (cursor < text.length) {
    const index = text.indexOf(value, cursor)
    if (index === -1) return output + text.slice(cursor)
    const before = index === 0 ? undefined : text[index - 1]
    const afterIndex = index + value.length
    const after = afterIndex === text.length ? undefined : text[afterIndex]
    output += text.slice(cursor, index)
    if (isPathBoundaryBefore(before) && isPathBoundaryAfter(after)) {
      output += placeholder
    } else {
      output += value
    }
    cursor = afterIndex
  }
  return output
}

export function assertNoUnsafeLocalPaths(text, location = 'Validation log') {
  if (typeof text !== 'string') throw new TypeError(`${location} must be text`)
  const inspectable = inspectableText(text)
  for (const pattern of UNSAFE_LOCAL_PATH_PATTERNS) {
    if (pattern.test(inspectable)) {
      throw new TypeError(`${location} retains an unsafe local absolute path`)
    }
  }
  for (const match of inspectable.matchAll(/<[a-z][a-z0-9-]*>/gu)) {
    if (!SUPPORTED_PLACEHOLDERS.has(match[0])) continue
    const before = match.index === 0 ? undefined : inspectable[match.index - 1]
    const afterIndex = match.index + match[0].length
    const after = afterIndex === inspectable.length
      ? undefined
      : inspectable[afterIndex]
    if (!isPathBoundaryBefore(before) || !isPathBoundaryAfter(after)) {
      throw new TypeError(`${location} embeds a path placeholder in another token`)
    }
  }
  for (const match of inspectable.matchAll(/file:(?:\/\/)?(<[a-z][a-z0-9-]*>)/giu)) {
    if (!SUPPORTED_PLACEHOLDERS.has(match[1])) {
      throw new TypeError(`${location} contains an unknown file-path placeholder`)
    }
  }
  return inspectable
}

export function normalizeValidationLogBytes(bytes, replacements) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new TypeError('Validation log normalization requires nonempty bytes')
  }
  let text
  try {
    text = utf8Decoder.decode(bytes)
  } catch (error) {
    throw new TypeError('Validation log must be valid UTF-8 before normalization', {
      cause: error,
    })
  }
  for (const [value, placeholder] of orderedReplacements(replacements)) {
    text = replaceBoundedPath(text, value, placeholder)
  }
  assertNoUnsafeLocalPaths(text)
  return Buffer.from(text)
}
