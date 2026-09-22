import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DSH_VERSION = '0.1.6-alpha.2'
const DSH_ARGS = ['--yes', `@deepseek-ai/dsh@${DSH_VERSION}`]
const PROFILE = 'web'
const EXPECTED_TOOLS = ['goal_quiescence_ack', 'goal_quiescence_status']

function run(command, args, options) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  })
  if (result.status !== 0) {
    throw new Error([
      `${command} ${args.join(' ')} exited ${result.status ?? 'without a status'}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'))
  }
  return result.stdout
}

async function createProbe(root) {
  const probe = join(root, 'tool-schema-probe')
  await mkdir(probe)
  await writeFile(join(probe, 'package.json'), `${JSON.stringify({
    name: 'dsh-goal-quiescence-tool-schema-probe',
    version: '1.0.0',
    type: 'module',
    main: './index.js',
    files: ['index.js', 'cordis.patch.yml'],
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2)}\n`)
  await writeFile(join(probe, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: goal-quiescence-tool-schema-probe',
    '      name: dsh-goal-quiescence-tool-schema-probe',
    '',
  ].join('\n'))
  await writeFile(join(probe, 'index.js'), [
    "import { writeFileSync } from 'node:fs'",
    '',
    "export const name = 'goal-quiescence-tool-schema-probe'",
    "export const inject = ['tools']",
    '',
    'export function apply(ctx) {',
    '  const output = process.env.GOAL_QUIESCENCE_SCHEMA_PROBE',
    "  if (!output) throw new Error('GOAL_QUIESCENCE_SCHEMA_PROBE is required')",
    '  void ctx.loader.await().then(() => {',
    '    const names = ctx.tools.schemas()',
    "      .map(schema => schema.name)",
    "      .filter(toolName => toolName.startsWith('goal_quiescence_'))",
    '      .sort()',
    "    writeFileSync(output, `${JSON.stringify(names, null, 2)}\\n`, 'utf8')",
    '  })',
    '}',
    '',
  ].join('\n'))
  return probe
}

function waitForServer(child, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => {
      reject(new Error(`DSH Web did not publish a URL within ${timeoutMs}ms\n${output}`))
    }, timeoutMs)
    const receive = chunk => {
      output += chunk.toString()
      const match = output.match(/dsh web: (http:\/\/[^\s]+)/)
      if (match === null) return
      clearTimeout(timer)
      resolve(match[1])
    }
    child.stdout.on('data', receive)
    child.stderr.on('data', receive)
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', code => {
      clearTimeout(timer)
      reject(new Error(`DSH Web exited ${code} before publishing a URL\n${output}`))
    })
  })
}

function signalServerTree(child, signal) {
  try {
    if (process.platform === 'win32') child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}

async function stopServer(child) {
  if (child.exitCode !== null) return
  const closed = new Promise(resolve => child.once('close', resolve))
  signalServerTree(child, 'SIGTERM')
  const graceful = await Promise.race([
    closed.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 5_000)),
  ])
  if (!graceful) {
    signalServerTree(child, 'SIGKILL')
    await closed
  }
}

async function waitForProbe(path, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  throw new Error(`tool schema probe did not write ${path} within ${timeoutMs}ms`)
}

async function fetchTrustedPage(url) {
  const bootstrap = await fetch(url, { redirect: 'manual' })
  if (bootstrap.status < 300 || bootstrap.status >= 400) return bootstrap
  const location = bootstrap.headers.get('location')
  const setCookie = bootstrap.headers.get('set-cookie')
  if (location === null || setCookie === null) {
    throw new Error(`DSH trust bootstrap returned HTTP ${bootstrap.status} without redirect credentials`)
  }
  return fetch(new URL(location, url), {
    headers: { cookie: setCookie.split(';', 1)[0] },
  })
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-goal-quiescence-smoke-'))
  let server
  try {
    const packJson = run('npm', ['pack', '--json', '--pack-destination', root], { cwd: process.cwd() })
    const pack = JSON.parse(packJson)[0]
    const tarball = join(root, pack.filename)
    const home = join(root, 'home')
    const probeOutput = join(root, 'tool-schemas.json')
    const probe = await createProbe(root)
    const environment = {
      ...process.env,
      DSH_HOME: home,
      GOAL_QUIESCENCE_SCHEMA_PROBE: probeOutput,
      NO_COLOR: '1',
    }

    run('npx', [...DSH_ARGS, 'plugin', '--profile', PROFILE, 'add', tarball], {
      cwd: process.cwd(),
      env: environment,
    })
    run('npx', [...DSH_ARGS, 'plugin', '--profile', PROFILE, 'add', probe], {
      cwd: process.cwd(),
      env: environment,
    })

    server = spawn('npx', [...DSH_ARGS, '--profile', PROFILE, '--no-open', '--host', '127.0.0.1', '--port', '0'], {
      cwd: process.cwd(),
      detached: process.platform !== 'win32',
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const url = await waitForServer(server)
    const [tools, response] = await Promise.all([waitForProbe(probeOutput), fetchTrustedPage(url)])
    if (JSON.stringify(tools) !== JSON.stringify(EXPECTED_TOOLS)) {
      throw new Error(`unexpected goal quiescence tools: ${JSON.stringify(tools)}`)
    }
    if (response.status !== 200) throw new Error(`DSH Web returned HTTP ${response.status}`)

    const sha256 = createHash('sha256').update(await readFile(tarball)).digest('hex')
    console.log(JSON.stringify({
      package: `${pack.name}@${pack.version}`,
      sha256,
      dshVersion: DSH_VERSION,
      nodeVersion: process.version,
      profile: PROFILE,
      tools,
      httpStatus: response.status,
    }))
  } finally {
    if (server !== undefined) await stopServer(server)
    await rm(root, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
