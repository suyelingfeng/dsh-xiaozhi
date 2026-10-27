#!/usr/bin/env node
// Publish a GitHub release for an existing tag, using that version's CHANGELOG section
// as the notes.
//
//   GITHUB_TOKEN=<token with repo scope> node scripts/publish-release.mjs v0.5.0
//
// The token is read from the environment and never written anywhere. Tags are pushed by
// `git push origin v0.5.0`; this only fills the Releases page for them.
import { readFileSync } from 'node:fs'

const tag = (process.argv[2] ?? '').trim()
if (tag === '') {
  console.error('usage: node scripts/publish-release.mjs v0.5.0')
  process.exit(2)
}
const token = (process.env.GITHUB_TOKEN ?? '').trim()
if (token === '') {
  console.error('set GITHUB_TOKEN first: GITHUB_TOKEN=... node scripts/publish-release.mjs ' + tag)
  process.exit(2)
}
const repo = (process.env.GITHUB_REPO ?? 'suyelingfeng/dsh-xiaozhi').trim()
const version = tag.replace(/^v/, '')

const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
const start = changelog.indexOf(`## [${version}]`)
if (start < 0) {
  console.error(`CHANGELOG.md has no section for ${version}`)
  process.exit(2)
}
const section = changelog.slice(start)
const nextHeading = section.indexOf('\n## [', 1)
const body = (nextHeading === -1 ? section : section.slice(0, nextHeading))
  .replace(/^## \[[^\]]*\][^\n]*\n/, '')
  .trim()

if (body === '') {
  console.error(`the ${version} section is empty; nothing to publish`)
  process.exit(2)
}

const response = await fetch(`https://api.github.com/repos/${repo}/releases`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
    'x-github-api-version': '2022-11-28',
  },
  body: JSON.stringify({ tag_name: tag, name: tag, body, draft: false, prerelease: false }),
})

let payload
try {
  payload = await response.json()
} catch {
  payload = {}
}
if (response.ok !== true) {
  const reason = Array.isArray(payload.errors)
    ? `${payload.message}: ${payload.errors.map((item) => item.message ?? item.code).join('; ')}`
    : (payload.message ?? `HTTP ${response.status}`)
  console.error(`failed: ${reason}`)
  process.exit(1)
}
console.log(`published ${tag}: ${payload.html_url} (${body.length} chars of notes)`)
