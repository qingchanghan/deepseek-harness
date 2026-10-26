/** Connection management and remote recorded history through two real Web hosts and the SSH process fixture. */
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { writeComposerDraft, saveFailureShot } from './support.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  seedSession, selectedSessionFixture, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/remote-hosts', import.meta.url))
const MODE = webSnapshotMode()
const SEED = fileURLToPath(new URL('../../../snapshots/web/lifecycle-chrome/session.v4.jsonl', import.meta.url))

// The SSH process fixture uses a POSIX executable; Windows retains its native transport lane.
describe.skipIf(process.platform === 'win32' || MODE === 'record')('web e2e: SSH remote hosts', () => {
  let local: WebScaffold
  let remote: WebScaffold
  let browser: Browser
  let page: Page
  let scratch: string | undefined
  let remoteSessionId: SessionId
  let tripwire: ReturnType<typeof watchConsole>
  const previousPath = process.env.PATH
  const previousDescriptor = process.env.DSH_REMOTE_HOST_FIXTURE

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'dsh-remote-hosts-e2e-'))
    remote = await launchWebScaffold({ replayFixture: SEED, compareReplaySession: false })
    const seed = await selectedSessionFixture(SEED, false)
    const id = remoteSessionId = await seedSession(remote, await readFile(seed, 'utf8'), 'remote-recorded-session', undefined, { createdAt: 1_700_000_000_000 })
    await remote.ctx.sessionController.rename({ sessionId: id, title: 'Recorded remote Session' })
    const url = new URL(remote.authenticatedUrl)
    const descriptor = join(scratch, 'instance.json')
    await writeFile(descriptor, JSON.stringify({
      version: 1, pid: process.pid, startedAt: '2026-10-26T00:00:00.000Z', protocol: 'http:',
      host: '127.0.0.1', port: Number(url.port), url: remote.authenticatedUrl, home: remote.harnessHome,
    }), { mode: 0o600 })
    const bin = join(scratch, 'bin')
    await mkdir(bin)
    const ssh = join(bin, 'ssh.mjs')
    const source = await readFile(new URL('./fixtures/ssh-loopback.mjs', import.meta.url), 'utf8')
    await writeFile(ssh, `#!${process.execPath}\n${source}`, { mode: 0o700 })
    await symlink('ssh.mjs', join(bin, 'ssh'))
    process.env.PATH = `${bin}${delimiter}${previousPath ?? ''}`
    process.env.DSH_REMOTE_HOST_FIXTURE = descriptor
    local = await launchWebScaffold({ profile: { packages: [] } })
    expect(local.ctx.remoteHosts.describe().writable).toBe(true)
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN', timezoneId: 'UTC' })
    tripwire = watchConsole(page)
    await page.goto(local.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: '主机', exact: true }).click()
    await page.getByRole('button', { name: '添加远程主机', exact: true }).waitFor({ state: 'visible' })
  })

  afterAll(async () => {
    try { await browser?.close() } finally {
      try { await local?.close() } finally {
        try { await remote?.close() } finally {
          if (previousPath === undefined) delete process.env.PATH
          else process.env.PATH = previousPath
          if (previousDescriptor === undefined) delete process.env.DSH_REMOTE_HOST_FIXTURE
          else process.env.DSH_REMOTE_HOST_FIXTURE = previousDescriptor
          if (scratch !== undefined) await rm(scratch, { recursive: true, force: true })
        }
      }
    }
  })

  it('adds a host after initialization, displays its Sessions automatically, and opens recorded history', async () => {
    await page.getByRole('button', { name: '添加远程主机', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '添加远程主机', exact: true })
    await dialog.getByRole('textbox', { name: '显示名称', exact: true }).fill('Loopback development machine')
    await dialog.getByRole('textbox', { name: /^SSH 目标/ }).fill('fixture')
    await dialog.getByRole('button', { name: '保存并连接', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    const host = page.getByRole('region', { name: 'Loopback development machine', exact: true })
    await host.getByRole('button', { name: /^Recorded remote Session/ }).waitFor()
    expect(await host.getByRole('status').textContent()).toBe('已连接')
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'hosts.expected.md'),
      await captureStableAria(page, '[data-hosts-panel]', remote.workspaceCwd), MODE)
    await host.getByRole('button', { name: /^Recorded remote Session/ }).click()
    await page.getByText('LIGHTHOUSE', { exact: true }).waitFor()
    expect(local.ctx.sessions.get(remoteSessionId)).toBeUndefined()
    expect(tripwire.pageErrors).toEqual([])
  })

  it('disconnects and reconnects without a page reload, preserving the profile entry', async () => {
    await page.getByRole('button', { name: '主机', exact: true }).click()
    const host = page.getByRole('region', { name: 'Loopback development machine', exact: true })
    await host.getByRole('button', { name: '断开', exact: true }).click()
    await expect.poll(() => host.getByRole('status').textContent()).toBe('未连接')
    await expect.poll(() => host.getByRole('button', { name: /^Recorded remote Session/ }).count()).toBe(0)
    const sidebar = page.locator('[data-sidebar-hosts]')
    await expect.poll(() => sidebar.getByRole('status').getAttribute('aria-label')).toBe('未连接')
    expect(await sidebar.getByRole('button', { name: 'Recorded remote Session', exact: true }).count()).toBe(0)
    await host.getByRole('button', { name: '连接', exact: true }).click()
    await host.getByRole('button', { name: /^Recorded remote Session/ }).waitFor()
    expect(await host.getByRole('status').textContent()).toBe('已连接')
    await sidebar.getByRole('button', { name: 'Recorded remote Session', exact: true }).waitFor()
    const patch = await readFile(local.ctx.settings.documentPath, 'utf8')
    expect(patch).toContain('Loopback development machine')
    expect(patch).toContain('fixture')
  })

  it('shows Local and remote hosts on startup and opens remote history directly from the sidebar', async () => {
    await page.reload({ waitUntil: 'load' })
    const hosts = page.locator('[data-workspace-hosts]')
    const sidebar = hosts.locator('[data-sidebar-hosts]')
    await sidebar.getByRole('button', { name: 'Recorded remote Session', exact: true }).waitFor()
    expect(await hosts.locator('summary').allTextContents()).toContain('Local')
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'sidebar.expected.md'),
      await captureStableAria(page, '[data-sidebar-hosts]', remote.workspaceCwd), MODE)
    await sidebar.getByRole('button', { name: 'Recorded remote Session', exact: true }).click()
    await page.getByText('LIGHTHOUSE', { exact: true }).waitFor()
    await expect.poll(() => sidebar.getByRole('button', { name: 'Recorded remote Session', exact: true }).getAttribute('aria-current')).toBe('page')
    expect(local.ctx.sessions.get(remoteSessionId)).toBeUndefined()
    await sidebar.locator('summary').click()
    expect(await sidebar.getByRole('button', { name: 'Recorded remote Session', exact: true }).isVisible()).toBe(false)
    await sidebar.locator('summary').click()
    await sidebar.getByRole('button', { name: 'Recorded remote Session', exact: true }).waitFor()
    await page.getByRole('button', { name: '搜索会话', exact: true }).click()
    const search = page.getByPlaceholder('搜索会话名称', { exact: true })
    await search.fill('no remote match')
    await sidebar.getByText('没有匹配的远程会话', { exact: true }).waitFor()
    await search.fill('recorded REMOTE')
    await sidebar.getByRole('button', { name: 'Recorded remote Session', exact: true }).waitFor()
    await search.press('Escape')
    await sidebar.getByRole('button', { name: '管理远程主机…', exact: true }).click()
    await page.getByRole('button', { name: '添加远程主机', exact: true }).waitFor()
  })

  it('creates in a remote Workspace, sends the first turn there, and restores it after reload', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-remote-new-session'))
    await page.getByRole('button', { name: '新建会话', exact: true }).last().click()
    const dialog = page.getByRole('dialog', { name: '新建会话', exact: true })
    expect(await dialog.getByRole('radio', { name: 'Loopback development machine', exact: true }).getAttribute('aria-checked')).toBe('true')
    await dialog.getByRole('textbox', { name: '添加工作区目录', exact: true }).fill(join(remote.workspaceCwd, 'missing'))
    await dialog.getByRole('button', { name: '添加工作区', exact: true }).click()
    await dialog.getByRole('alert').waitFor()
    expect(await dialog.isVisible()).toBe(true)
    const directory = join(remote.workspaceCwd, 'remote-project')
    await mkdir(directory)
    await dialog.getByRole('textbox', { name: '添加工作区目录', exact: true }).fill(directory)
    await dialog.getByRole('button', { name: '添加工作区', exact: true }).click()
    const choice = dialog.getByRole('radio', { name: /remote-project/ })
    await expect.poll(() => choice.getAttribute('aria-checked')).toBe('true')
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'new-session.expected.md'),
      await captureStableAria(page, '[data-new-session-picker]', remote.workspaceCwd), MODE)
    await dialog.getByRole('radio', { name: 'Local', exact: true }).click()
    expect(await dialog.getByRole('radio', { name: /remote-project/ }).count()).toBe(0)
    await dialog.getByRole('radio', { name: 'Loopback development machine', exact: true }).click()
    await choice.click()
    await dialog.getByRole('button', { name: '创建会话', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    const input = page.locator('[data-composer-input]').first()
    await writeComposerDraft(page, input, 'Reply with the single word LIGHTHOUSE and stop.')
    const settled = remote.whenTurnSettled()
    await input.press('Enter')
    const created = await settled
    expect(local.ctx.sessions.get(created)).toBeUndefined()
    expect(remote.ctx.sessions.get(created)?.header.cwd).toBe(directory)
    expect(local.ctx.workspaceRegistry.list().some(workspace => workspace.path === directory)).toBe(false)
    await page.getByText('LIGHTHOUSE', { exact: true }).waitFor()
    await page.reload({ waitUntil: 'load' })
    await page.getByText('LIGHTHOUSE', { exact: true }).waitFor()
    expect(tripwire.pageErrors).toEqual([])
  })

  it('creates on Local when Local is selected in the same destination picker', async () => {
    const remoteIds = remote.ctx.workspaceRegistry.list().flatMap(workspace => workspace.sessionIds)
    await page.getByRole('button', { name: '新建会话', exact: true }).last().click()
    const dialog = page.getByRole('dialog', { name: '新建会话', exact: true })
    await dialog.getByRole('radio', { name: 'Local', exact: true }).click()
    await dialog.getByRole('textbox', { name: '添加工作区目录', exact: true }).fill(local.workspaceCwd)
    await dialog.getByRole('button', { name: '添加工作区', exact: true }).click()
    await expect.poll(() => dialog.getByRole('button', { name: '创建会话', exact: true }).isEnabled()).toBe(true)
    await dialog.getByRole('button', { name: '创建会话', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    const workspace = local.ctx.workspaceRegistry.list().find(item => item.path === local.workspaceCwd)
    expect(workspace?.sessionIds).toHaveLength(1)
    const id = workspace?.sessionIds[0]
    expect(id).toBeDefined()
    expect(id === undefined ? undefined : local.ctx.sessions.get(id)?.header.cwd).toBe(local.workspaceCwd)
    expect(remote.ctx.workspaceRegistry.list().flatMap(item => item.sessionIds)).toEqual(remoteIds)
  })

  it('keeps failed connections visible, fits a narrow viewport, and removes saved connections', async () => {
    await page.getByRole('button', { name: '主机', exact: true }).click()
    await page.getByRole('button', { name: '添加远程主机', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '添加远程主机', exact: true })
    await dialog.getByRole('textbox', { name: '显示名称', exact: true }).fill('Unavailable machine')
    await dialog.getByRole('textbox', { name: /^SSH 目标/ }).fill('unreachable-fixture')
    await dialog.getByRole('button', { name: '保存并连接', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    const failed = page.getByRole('region', { name: 'Unavailable machine', exact: true })
    await expect.poll(() => failed.getByRole('status').textContent()).toBe('连接失败')
    expect(await failed.getByRole('alert').textContent()).toContain('fixture SSH connection refused')
    await page.setViewportSize({ width: 390, height: 844 })
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    const openSidebar = page.getByRole('button', { name: '打开侧边栏', exact: true })
    if (await openSidebar.isVisible()) await openSidebar.click()
    const sidebar = page.locator('[data-sidebar-hosts]')
    await sidebar.getByText('Unavailable machine', { exact: true }).waitFor()
    await sidebar.getByRole('button', { name: 'Recorded remote Session', exact: true }).waitFor()
    const bounds = await sidebar.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
    await page.getByRole('button', { name: '新建会话', exact: true }).last().click()
    const picker = page.getByRole('dialog', { name: '新建会话', exact: true })
    await picker.getByRole('radio', { name: 'Unavailable machine', exact: true }).click()
    expect(await picker.getByRole('button', { name: '创建会话', exact: true }).isDisabled()).toBe(true)
    await picker.getByText('请先连接所选主机', { exact: true }).waitFor()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await picker.getByRole('button', { name: '取消', exact: true }).click()
    await page.setViewportSize({ width: 1280, height: 900 })
    await failed.getByRole('button', { name: '移除', exact: true }).click()
    await page.getByRole('dialog', { name: '移除远程主机', exact: true }).getByRole('button', { name: '移除', exact: true }).click()
    await failed.waitFor({ state: 'hidden' })
    expect(await readFile(local.ctx.settings.documentPath, 'utf8')).not.toContain('unreachable-fixture')
    expect(tripwire.pageErrors).toEqual([])
  })

  it('keeps its borrowed recorded-session inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['hosts.expected.md', 'sidebar.expected.md', 'new-session.expected.md'])
  })
})
