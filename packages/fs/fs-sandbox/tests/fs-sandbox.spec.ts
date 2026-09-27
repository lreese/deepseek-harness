/**
 * Tests for the sandbox-enforcing filesystem backend: the per-call policy fence
 * on write/edit (read-only denies, workspace-write contains, danger-full-access
 * passes through), reads always passing through, the capability fact, and the
 * containment matrix — `..` traversal, absolute paths outside, and symlink
 * escapes (a symlinked directory inside the workspace pointing out, and a new
 * file created under one). The fence is exercised on a real filesystem: a
 * denied write leaves no file on disk.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { FsError, FsTargetKey } from '@deepseek-ai/dsh-fs'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import SandboxPolicyService, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { assertWorkspaceOutsideTemp, outsideTempWorkspaceParent } from '../../../../scripts/snapshot-workspace-parent.ts'

let base: string
let workspace: string
let outside: string
let ctx: Context
let fs: SandboxedFileSystem
let fiber: Awaited<ReturnType<Context['plugin']>>

async function boot(mode: SandboxMode): Promise<void> {
  ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: workspace })
  fiber = await ctx.plugin(SandboxedFileSystem, { cwd: workspace })
  fs = ctx.fs as SandboxedFileSystem
}

beforeEach(async ({ onTestFinished }) => {
  // Both siblings must be outside automatic temp grants for containment denials to be meaningful.
  const directory = await mkdtemp(join(outsideTempWorkspaceParent(), '.dsh-fssbx-'))
  onTestFinished(async () => { await rm(directory, { recursive: true, force: true }) })
  base = directory
  assertWorkspaceOutsideTemp(base)
  workspace = join(base, 'ws')
  outside = join(base, 'out')
  await mkdir(workspace)
  await mkdir(outside)
})
afterEach(async () => {
  await fiber?.dispose()
})

/** Resolve a path through the backend and return its target. */
function target(path: string): Promise<FsTarget> {
  return fs.resolve(path)
}

describe('the capability fact', () => {
  it('reports the deployment default mode (what the tool layer advertises against)', async () => {
    await boot('workspace-write')
    expect(fs.sandboxMode).toBe('workspace-write')
  })
})

describe('read-only', () => {
  beforeEach(() => boot('read-only'))

  it('denies write, leaving no file on disk', async () => {
    const path = join(workspace, 'denied.txt')
    await expect(fs.writeText(await target(path), 'x')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(path)).toBe(false)
  })

  it('denies edit of an existing file (the content is unchanged)', async () => {
    const path = join(workspace, 'file.txt')
    await writeFile(path, 'original')
    await expect(fs.editText(await target(path), { oldString: 'original', newString: 'changed', replaceAll: false }))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(await readFile(path, 'utf8')).toBe('original')
  })

  it('allows reads (every mode permits reading)', async () => {
    const path = join(workspace, 'readable.txt')
    await writeFile(path, 'hello')
    expect(await fs.readText(await target(path))).toBe('hello')
  })
})

describe('workspace-write containment', () => {
  beforeEach(() => boot('workspace-write'))

  it('a write under the workspace lands', async () => {
    const path = join(workspace, 'nested', 'ok.txt')
    const outcome = await fs.writeText(await target(path), 'inside')
    expect(outcome.operation).toBe('create')
    expect(await readFile(path, 'utf8')).toBe('inside')
  })

  it('a write to the platform temp area lands (parity with the bash runner grant)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-fssbx-tmp-'))
    try {
      const path = join(dir, 'temp.txt')
      await fs.writeText(await target(path), 'temp')
      expect(await readFile(path, 'utf8')).toBe('temp')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('an absolute path outside the workspace is denied, no file created', async () => {
    const path = join(outside, 'escape.txt')
    await expect(fs.writeText(await target(path), 'x')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(path)).toBe(false)
  })

  it('a `..` traversal out of the workspace is denied', async () => {
    const path = join(workspace, '..', 'sibling-escape.txt')
    await expect(fs.writeText(await target(path), 'x')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(join(workspace, '..', 'sibling-escape.txt'))).toBe(false)
  })

  it('a symlinked directory inside the workspace pointing OUT is denied (canonicalized before containment)', async () => {
    // workspace/link -> outside ; writing workspace/link/f.txt would land in outside/f.txt.
    await symlink(outside, join(workspace, 'link'))
    const path = join(workspace, 'link', 'f.txt')
    await expect(fs.writeText(await target(path), 'x')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(join(outside, 'f.txt'))).toBe(false)
  })

  it('a NEW file created under a symlinked-out directory is denied (deepest-ancestor realpath)', async () => {
    await symlink(outside, join(workspace, 'link'))
    const path = join(workspace, 'link', 'newdir', 'deep.txt')
    await expect(fs.writeText(await target(path), 'x')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(join(outside, 'newdir'))).toBe(false)
  })

  it('an edit outside the workspace is denied; the original is untouched', async () => {
    const path = join(outside, 'file.txt')
    await writeFile(path, 'original')
    await expect(fs.editText(await target(path), { oldString: 'original', newString: 'x', replaceAll: false }))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(await readFile(path, 'utf8')).toBe('original')
  })

  it('an edit inside the workspace lands', async () => {
    const path = join(workspace, 'edit.txt')
    await writeFile(path, 'original')
    const outcome = await fs.editText(await target(path), { oldString: 'original', newString: 'changed', replaceAll: false })
    expect(outcome.after).toBe('changed')
    expect(await readFile(path, 'utf8')).toBe('changed')
  })

  it('mutates the freshly checked identity, not a stale outside targetKey (TOCTOU direction)', async () => {
    // A target whose displayPath is inside the workspace but whose targetKey is
    // a STALE outside path — as if an ancestor symlink pointed out at the tool's
    // resolve() and was swapped in before the write. The fence re-resolves
    // displayPath (now inside) AND delegates with that fresh target, so the byte
    // lands inside and the stale outside path is never written.
    const insidePath = join(workspace, 'landed.txt')
    const staleTarget: FsTarget = { displayPath: insidePath, targetKey: FsTargetKey(join(outside, 'escaped.txt')) }
    await fs.writeText(staleTarget, 'inside')
    expect(await readFile(insidePath, 'utf8')).toBe('inside')
    expect(existsSync(join(outside, 'escaped.txt'))).toBe(false)
  })

  it('the workspace root itself passes the fence (path equal to a writable root), failing only on file type', async () => {
    // isUnder's path-equals-root branch: the fence allows the root, and the
    // write then fails because the root is a directory, not a regular file.
    await expect(fs.writeText(await target(workspace), 'x')).rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
  })
})

describe('workspace-write with the filesystem root as the workspace (a root ending in the path separator)', () => {
  it('grants writes anywhere on that volume', async () => {
    // A degenerate but valid config: the filesystem root containing the target.
    // It exercises the separator-suffixed-root branch on POSIX and Windows.
    const rootCtx = new Context()
    await rootCtx.plugin(SessionProjectionRegistry)
    await rootCtx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: parse(base).root })
    const rootFiber = await rootCtx.plugin(SandboxedFileSystem, { cwd: workspace })
    const rootFs = rootCtx.fs as SandboxedFileSystem
    try {
      const path = join(base, 'anywhere.txt') // outside temp — allowed only via the filesystem root
      await rootFs.writeText(await rootFs.resolve(path), 'anywhere')
      expect(await readFile(path, 'utf8')).toBe('anywhere')
    } finally {
      await rootFiber.dispose()
    }
  })
})

describe('danger-full-access', () => {
  beforeEach(() => boot('danger-full-access'))

  it('writes anywhere, unfenced', async () => {
    const path = join(outside, 'free.txt')
    await fs.writeText(await target(path), 'free')
    expect(await readFile(path, 'utf8')).toBe('free')
  })
})

describe('initiator attribution (plugin ctx.fs writes use the invoking session)', () => {
  /** Boot with the fallback root DISTINCT from the session workspace, isolating the two roots. */
  async function bootAttributed(mode: SandboxMode): Promise<void> {
    ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: outside })
    fiber = await ctx.plugin(SandboxedFileSystem, { cwd: workspace })
    fs = ctx.fs as SandboxedFileSystem
  }

  /** An agent whose session is rooted at the workspace. */
  function workspaceAgent(): Agent {
    const session = ctx.sessions.create(SessionId('attributed'), { meta: { cwd: workspace } })
    return { id: session.id, session } as Agent
  }

  it("a write inside the initiator session's cwd lands though outside the fallback root", async () => {
    await bootAttributed('workspace-write')
    const path = join(workspace, 'attributed.txt')
    await ctx.agents.withInitiator(workspaceAgent(), async () => fs.writeText(await fs.resolve(path), 'session-principal'))
    expect(await readFile(path, 'utf8')).toBe('session-principal')
  })

  it('keeps the attribution across handler awaits (the async chain inherits the boundary)', async () => {
    await bootAttributed('workspace-write')
    const path = join(workspace, 'async-attributed.txt')
    const agent = workspaceAgent()
    // The write is preceded by an await INSIDE the boundary, as a plugin handler does.
    const write = ctx.agents.withInitiator(agent, async () => {
      await Promise.resolve()
      await fs.writeText(await fs.resolve(path), 'after-await')
    })
    await write
    expect(await readFile(path, 'utf8')).toBe('after-await')
  })

  it('a write outside the initiator session cwd is still denied (containment unchanged)', async () => {
    await bootAttributed('workspace-write')
    // `outside` IS the fallback root; the session boundary must replace it, not widen to it.
    const path = join(outside, 'escape.txt')
    await expect(ctx.agents.withInitiator(workspaceAgent(), async () => fs.writeText(await fs.resolve(path), 'x')))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(path)).toBe(false)
  })

  it('a read-only default denies even with an initiator session', async () => {
    await bootAttributed('read-only')
    const path = join(workspace, 'denied.txt')
    await expect(ctx.agents.withInitiator(workspaceAgent(), async () => fs.writeText(await fs.resolve(path), 'x')))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(path)).toBe(false)
  })

  it('agentless calls keep the fallback root (a write outside it is denied)', async () => {
    await bootAttributed('workspace-write')
    const path = join(workspace, 'fallback-denied.txt')
    await expect(fs.writeText(await target(path), 'x')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(path)).toBe(false)
  })

  it("a session's read-only override denies what the workspace-write default would allow", async () => {
    await bootAttributed('workspace-write')
    const session = ctx.sessions.create(SessionId('overridden'), { meta: { cwd: workspace } })
    setSandboxMode(session, 'read-only')
    const agent = { id: session.id, session } as Agent
    const path = join(workspace, 'override-denied.txt')
    await expect(ctx.agents.withInitiator(agent, async () => fs.writeText(await fs.resolve(path), 'x')))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(path)).toBe(false)
  })

  it("a session's workspace-write override allows what the read-only default would deny", async () => {
    await bootAttributed('read-only')
    const session = ctx.sessions.create(SessionId('elevated'), { meta: { cwd: workspace } })
    setSandboxMode(session, 'workspace-write')
    const agent = { id: session.id, session } as Agent
    const path = join(workspace, 'override-allowed.txt')
    await ctx.agents.withInitiator(agent, async () => fs.writeText(await fs.resolve(path), 'override'))
    expect(await readFile(path, 'utf8')).toBe('override')
  })

  it('end to end: a slash-command handler write through ctx.fs lands under the invoking session', async () => {
    await bootAttributed('workspace-write')
    await ctx.plugin(CommandRuntime)
    const session = ctx.sessions.create(SessionId('commander'), { meta: { cwd: workspace } })
    const agent = { id: session.id, session } as Agent
    const path = join(workspace, 'command-written.txt')
    ctx.commands.register({
      name: 'write',
      description: 'Write through ctx.fs inside the handler',
      handler: async () => {
        await fs.writeText(await fs.resolve(path), 'from-command')
        return { kind: 'success' }
      },
    })
    const execution = await ctx.commands.execute(agent, '/write', [], new AbortController().signal)
    expect(execution?.result).toEqual({ kind: 'success' })
    expect(await readFile(path, 'utf8')).toBe('from-command')
  })
})

describe('the per-call policy override (escalation)', () => {
  it('a workspace-write stamp on a read-only default lets a contained write land for that call only', async () => {
    await boot('read-only')
    const path = join(workspace, 'escalated.txt')
    // Default read-only would deny; the per-call workspace-write policy allows it (contained).
    await fs.writeText(await target(path), 'granted', undefined, undefined, { mode: 'workspace-write', workspaceRoot: workspace })
    expect(await readFile(path, 'utf8')).toBe('granted')
    // A neighboring plain call still runs under the read-only default.
    await expect(fs.writeText(await target(join(workspace, 'plain.txt')), 'x'))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })

  it('a danger-full-access stamp bypasses the fence for that call', async () => {
    await boot('read-only')
    const path = join(outside, 'granted-full.txt')
    await fs.writeText(await target(path), 'full', undefined, undefined, { mode: 'danger-full-access', workspaceRoot: workspace })
    expect(await readFile(path, 'utf8')).toBe('full')
  })
})

describe('registration and HMR safety', () => {
  it('registers as ctx.fs and unregisters cleanly from a child fiber', async () => {
    await boot('workspace-write')
    expect(ctx.fs).toBeInstanceOf(SandboxedFileSystem)
    await fiber.dispose()
    expect(ctx.get('fs')).toBeUndefined()
    // Re-mount below the disposed one to prove no lingering registration.
    fiber = await ctx.plugin(SandboxedFileSystem, { cwd: workspace })
    expect(ctx.fs).toBeInstanceOf(SandboxedFileSystem)
  })
})

describe('FsError identity', () => {
  it('the denial is a structured FsError distinct from a host permission error', async () => {
    await boot('read-only')
    const error = await fs.writeText(await target(join(workspace, 'x.txt')), 'x').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(FsError)
    expect((error as FsError).code).toBe('FS_SANDBOX_DENIED')
  })
})
