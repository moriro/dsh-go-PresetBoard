// local-preset-board: 输入框上方只有一个「预设」胶囊。
// 面板顶部用「浏览 / 编辑」切换：
//   浏览 —— 按分组列出预设，点一条换行插入输入框，不发送；
//   编辑 —— 点预设改名称/备注/#标签/分组/内容/置顶，点分组改分组；
//          也可以新建、排序、删除，以及导入 / 导出文件。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-presetboard'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const DATA_FILE = join(DSH_HOME, 'dsh-go', 'plugin-data', 'preset-board', 'data.json')
const LEGACY_FILE = join(ROOT, 'data', 'presets.json')

const TAG_MAX = 8
const TAG_LENGTH = 12

const SEED = [
  { name: '猫娘', note: 'Be a catgirl.', tags: ['人设'], text: '你是一只可爱的猫娘。' },
]

let state = load()
let mode = 'browse'
let lastDraft = ''
let editingPresetId = null
let editingGroupId = null
let deletePresetArmed = false
let deleteGroupArmed = false

// ───────────────────────── 数据 ─────────────────────────

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

function validId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/.test(value)
}

function clean(value, max) {
  return String(value ?? '').trim().slice(0, max)
}

function firstLine(text) {
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed !== '') return trimmed
  }
  return ''
}

function normalizeTags(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[\s,，、]+/)
  const out = []
  for (const raw of list) {
    const tag = String(raw ?? '').replace(/^#+/, '').trim().slice(0, TAG_LENGTH)
    if (tag === '' || out.includes(tag)) continue
    out.push(tag)
    if (out.length >= TAG_MAX) break
  }
  return out
}

function parseTagInput(value) {
  return normalizeTags(String(value ?? '').replace(/#/g, ' #'))
}

function normalizePreset(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const name = clean(value.name, 40)
  const text = clean(value.text, 2000)
  if (name === '' && text === '') return null
  return {
    id: validId(value.id) ? value.id : newId('p'),
    name: name === '' ? firstLine(text).slice(0, 20) : name,
    note: clean(value.note, 80),
    tags: normalizeTags(value.tags),
    text,
    groupId: validId(value.groupId) ? value.groupId : null,
    pinned: value.pinned === true,
    createdAt: Number.isFinite(value.createdAt) ? value.createdAt : Date.now(),
  }
}

function normalizeGroup(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const name = clean(value.name, 20)
  if (name === '') return null
  return {
    id: validId(value.id) ? value.id : newId('g'),
    name,
    pinned: value.pinned === true,
    createdAt: Number.isFinite(value.createdAt) ? value.createdAt : Date.now(),
  }
}

function seed() {
  const presets = SEED.map((item, index) => ({
    id: `seed-p-${index + 1}`,
    name: item.name,
    note: item.note,
    tags: item.tags,
    text: item.text,
    groupId: null,
    pinned: false,
    createdAt: Date.now() + index,
  }))
  return { groups: [], presets }
}

function load() {
  if (existsSync(DATA_FILE)) {
    try {
      const raw = JSON.parse(readFileSync(DATA_FILE, 'utf8'))
      return normalizeBoard(raw)
    } catch {
      return { groups: [], presets: [] }
    }
  }
  if (existsSync(LEGACY_FILE)) {
    try {
      const raw = JSON.parse(readFileSync(LEGACY_FILE, 'utf8'))
      const migrated = normalizeBoard(raw)
      if (migrated.presets.length > 0) {
        persistBoard(migrated)
        return migrated
      }
    } catch {
      // 旧数据读不出来时退回默认预设。
    }
  }
  const seeded = seed()
  persistBoard(seeded)
  return seeded
}

function normalizeBoard(raw) {
  const groups = Array.isArray(raw?.groups) ? raw.groups.map(normalizeGroup).filter(Boolean) : []
  const groupIds = new Set(groups.map((group) => group.id))
  const presets = Array.isArray(raw?.presets) ? raw.presets.map(normalizePreset).filter(Boolean) : []
  for (const preset of presets) {
    if (preset.groupId !== null && !groupIds.has(preset.groupId)) preset.groupId = null
  }
  return { groups, presets }
}

function persistBoard(board = state) {
  try {
    mkdirSync(dirname(DATA_FILE), { recursive: true })
    const temp = `${DATA_FILE}.tmp`
    writeFileSync(temp, JSON.stringify({ v: 2, groups: board.groups, presets: board.presets }, null, 2))
    renameSync(temp, DATA_FILE)
  } catch {
    // 写不进去时保留内存内容，下次启动回到上次成功保存的版本。
  }
}

function orderedGroups() {
  const groups = [...state.groups].sort((a, b) => Number(b.pinned) - Number(a.pinned))
  return groups
}

function itemsIn(groupId) {
  const items = state.presets.filter((preset) => (preset.groupId ?? null) === (groupId ?? null))
  return [...items].sort((a, b) => Number(b.pinned) - Number(a.pinned))
}

function ungroupedItems() {
  return itemsIn(null)
}

function groupOf(id) {
  return state.groups.find((group) => group.id === id) ?? null
}

function presetOf(id) {
  return state.presets.find((preset) => preset.id === id) ?? null
}

function groupName(id) {
  const group = groupOf(id)
  return group === null ? '未分组' : group.name
}

function tagsLabel(tags) {
  return (tags ?? []).map((tag) => `#${tag}`).join(' ')
}

// ───────────────────────── 文案小工具 ─────────────────────────

function clip(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value
}

function stamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
}

// ───────────────────────── 视图 ─────────────────────────

function presetRow(preset, action, showGroup = false) {
  const tags = tagsLabel(preset.tags)
  const subtitle = [showGroup ? groupName(preset.groupId) : '', clip(preset.note || firstLine(preset.text), 40)]
    .filter((part) => part !== '')
    .join(' · ')
  return {
    title: preset.name,
    subtitle,
    icon: preset.pinned ? 'pin' : 'note',
    trailing: tags,
    action: { id: action, args: { id: preset.id } },
  }
}

function groupRow(group, action) {
  const count = itemsIn(group.id).length
  return {
    title: group.name,
    subtitle: `${count} 条`,
    icon: group.pinned ? 'pin' : 'folder',
    trailing: group.pinned ? '置顶' : '',
    action: { id: action, args: { id: group.id } },
  }
}

function browseView(caps) {
  const children = []
  const groups = orderedGroups()
  let shown = 0
  for (const group of groups) {
    const items = itemsIn(group.id)
    if (items.length === 0) continue
    shown += items.length
    children.push({ type: 'text', text: group.pinned ? `${group.name} · 置顶` : group.name, style: { size: 'subtitle', weight: 'semibold' } })
    children.push({ type: 'list', items: items.map((preset) => presetRow(preset, 'preset-use')) })
  }
  const loose = ungroupedItems()
  if (loose.length > 0) {
    if (groups.length > 0) children.push({ type: 'text', text: '未分组', style: { size: 'subtitle', weight: 'semibold' } })
    children.push({ type: 'list', items: loose.map((preset) => presetRow(preset, 'preset-use')) })
    shown += loose.length
  }
  if (shown === 0) {
    children.push({ type: 'emptyState', title: '还没有预设', message: '切到「编辑」新建一条常用指令。', icon: 'list' })
  }
  return children
}

function editView(caps) {
  const children = []
  const groups = orderedGroups()
  children.push({ type: 'text', text: '分组', tone: 'muted', style: { size: 'caption' } })
  if (groups.length === 0) {
    children.push({ type: 'text', text: '还没有分组，新建一个可以给预设归类。', tone: 'muted' })
  } else {
    children.push({ type: 'list', items: groups.map((group) => groupRow(group, 'group-open')) })
  }
  children.push({ type: 'text', text: '预设', tone: 'muted', style: { size: 'caption' } })
  if (state.presets.length === 0) {
    children.push({ type: 'text', text: '还没有预设。', tone: 'muted' })
  } else {
    const rows = []
    for (const group of groups) for (const preset of itemsIn(group.id)) rows.push(presetRow(preset, 'preset-open', true))
    for (const preset of ungroupedItems()) rows.push(presetRow(preset, 'preset-open', true))
    children.push({ type: 'list', items: rows })
  }
  children.push({ type: 'actions', items: [
    { label: '新建预设', icon: 'add', action: 'preset-new' },
    { label: '新建分组', icon: 'folder', action: 'group-new' },
    { label: '粘贴添加', icon: 'paste', action: 'preset-add-open' },
  ] })
  const dataActions = []
  if (caps?.features?.includes('files')) dataActions.push({ label: '导入', icon: 'download', action: 'board-import' })
  dataActions.push({ label: '导出', icon: 'downloads', action: 'board-export' })
  children.push({ type: 'actions', items: dataActions })
  return children
}

function presetEditView() {
  const preset = presetOf(editingPresetId)
  const header = preset === null ? '新建预设' : `修改「${clip(preset.name, 20)}」`
  const children = [
    { type: 'text', text: header, style: { size: 'subtitle', weight: 'semibold' } },
    {
      type: 'form',
      submit: 'preset-save',
      submitLabel: '保存',
      children: [
        { type: 'textField', label: '名称', bind: 'data.form.name', placeholder: '例如：总结要点', required: true, maxLength: 40 },
        { type: 'textField', label: '备注', bind: 'data.form.note', placeholder: '一句话说明这条预设干什么', maxLength: 80 },
        { type: 'textField', label: '标签', bind: 'data.form.tags', placeholder: '#写作 #总结，空格或逗号分隔', maxLength: 60 },
        {
          type: 'select',
          label: '分组',
          bind: 'data.form.group',
          options: [{ label: '未分组', value: 'none' }, ...orderedGroups().map((group) => ({ label: group.name, value: group.id }))],
        },
        {
          type: 'textField',
          label: '内容',
          bind: 'data.form.text',
          placeholder: '插入输入框的文字，可以多行',
          required: true,
          multiline: true,
          maxLines: 8,
          maxLength: 2000,
          onChange: 'content-changed',
        },
        { type: 'text', text: { $: 'data.form.countText' }, style: { color: { $: 'data.form.countColor' }, weight: 'semibold' } },
        { type: 'toggle', label: '置顶', bind: 'data.form.pinned' },
      ],
    },
  ]
  if (preset !== null && deletePresetArmed) {
    children.push({ type: 'callout', tone: 'warn', text: `删除「${clip(preset.name, 20)}」？删除后不能恢复。` })
    children.push({ type: 'confirm', id: 'preset-remove', confirmLabel: '删除', cancelLabel: '取消' })
  }
  if (preset !== null && !deletePresetArmed) {
    children.push({ type: 'actions', items: [
      { label: '上移', icon: 'expand', action: 'preset-up' },
      { label: '下移', icon: 'collapse', action: 'preset-down' },
      { label: '分享', icon: 'share', action: 'preset-share' },
    ] })
    children.push({ type: 'actions', items: [
      { label: '删除', icon: 'delete', action: 'preset-ask-delete' },
      { label: '返回', action: 'preset-back' },
    ] })
  } else {
    children.push({ type: 'actions', items: [{ label: '返回', action: 'preset-back' }] })
  }
  return { v: 2, type: 'stack', children }
}

function groupEditView() {
  const group = groupOf(editingGroupId)
  const header = group === null ? '分组' : `修改分组「${clip(group.name, 16)}」`
  const children = [
    { type: 'text', text: header, style: { size: 'subtitle', weight: 'semibold' } },
    {
      type: 'form',
      submit: 'group-save',
      submitLabel: '保存',
      children: [
        { type: 'textField', label: '名称', bind: 'data.form.name', placeholder: '例如：日常', required: true, maxLength: 20 },
      ],
    },
  ]
  if (group !== null) {
    children.push({ type: 'text', text: `${itemsIn(group.id).length} 条预设在这个分组里。`, tone: 'muted', style: { size: 'caption' } })
  }
  if (group !== null && deleteGroupArmed) {
    children.push({ type: 'callout', tone: 'warn', text: `删除分组「${clip(group.name, 16)}」？组里的预设会移到未分组。` })
    children.push({ type: 'confirm', id: 'group-remove', confirmLabel: '删除', cancelLabel: '取消' })
  }
  if (group !== null && !deleteGroupArmed) {
    children.push({ type: 'actions', items: [
      { label: group.pinned ? '取消置顶' : '置顶', icon: group.pinned ? 'pin' : 'favorite', action: 'group-pin' },
      { label: '上移', icon: 'expand', action: 'group-up' },
      { label: '下移', icon: 'collapse', action: 'group-down' },
    ] })
  }
  const actions = []
  if (group !== null && !deleteGroupArmed) actions.push({ label: '删除', icon: 'delete', action: 'group-ask-delete' })
  actions.push({ label: '返回', action: 'group-back' })
  children.push({ type: 'actions', items: actions })
  return { v: 2, type: 'stack', children }
}

function addView() {
  return {
    v: 2,
    type: 'stack',
    children: [
      { type: 'text', text: '把分享码粘贴到下面，就能加进预设板。', tone: 'muted', style: { size: 'caption' } },
      {
        type: 'form',
        submit: 'share-add',
        submitLabel: '添加',
        children: [
          {
            type: 'textField',
            label: '分享码',
            bind: 'data.form.code',
            placeholder: 'DSHGO-PRESET:1:…',
            multiline: true,
            maxLines: 6,
            maxLength: 2000,
          },
        ],
      },
      { type: 'actions', items: [{ label: '返回', action: 'add-back' }] },
    ],
  }
}

// ───────────────────────── 行为 ─────────────────────────

function usePreset(id) {
  const preset = presetOf(id)
  if (preset === null) return { toast: '这条预设不见了' }
  if (preset.text.trim() === '') return { toast: '这条预设还没有内容' }
  const prefix = lastDraft.trim() === '' ? '' : '\n'
  const text = `${prefix}${preset.text}`.slice(0, 2000)
  lastDraft = `${lastDraft}${text}`.slice(-4000)
  return { insert: text, toast: '已插入' }
}

function savePreset(values) {
  const map = values !== null && typeof values === 'object' ? values : {}
  const name = clean(map['data.form.name'], 40)
  const note = clean(map['data.form.note'], 80)
  const tags = parseTagInput(map['data.form.tags'])
  const text = clean(map['data.form.text'], 2000)
  const pinned = map['data.form.pinned'] === true
  const rawGroup = map['data.form.group']
  const groupId = typeof rawGroup === 'string' && groupOf(rawGroup) !== null ? rawGroup : null
  if (name === '') return { toast: '名称不能为空' }
  if (text === '') return { toast: '内容不能为空' }
  const existing = presetOf(editingPresetId)
  if (existing === null) {
    state.presets.push({ id: newId('p'), name, note, tags, text, groupId, pinned, createdAt: Date.now() })
  } else {
    Object.assign(existing, { name, note, tags, text, groupId, pinned })
  }
  deletePresetArmed = false
  persistBoard()
  mode = 'edit'
  return [
    { type: 'patch', id: 'presets', data: { ui: { mode: 'edit' } } },
    { type: 'open', page: 'panel:presets' },
    { type: 'toast', text: '已保存' },
  ]
}

function movePreset(id, delta) {
  const preset = presetOf(id)
  if (preset === null) return { toast: '这条预设不见了' }
  const list = itemsIn(preset.groupId)
  const from = list.indexOf(preset)
  const to = from + delta
  if (from < 0 || to < 0 || to >= list.length) return { toast: delta < 0 ? '已经是最前了' : '已经是最后了' }
  const other = list[to]
  if (other.pinned !== preset.pinned) return { toast: '置顶的预设单独排在前面' }
  const a = state.presets.indexOf(preset)
  const b = state.presets.indexOf(other)
  state.presets[a] = other
  state.presets[b] = preset
  persistBoard()
  return { refresh: true, toast: '已移动' }
}

function askDeletePreset() {
  if (presetOf(editingPresetId) === null) return { toast: '没有可删除的预设' }
  deletePresetArmed = true
  return { refresh: true }
}

function removePreset() {
  const preset = presetOf(editingPresetId)
  if (preset === null) return { toast: '没有可删除的预设' }
  state.presets = state.presets.filter((entry) => entry.id !== preset.id)
  deletePresetArmed = false
  editingPresetId = null
  persistBoard()
  mode = 'edit'
  return [
    { type: 'patch', id: 'presets', data: { ui: { mode: 'edit' } } },
    { type: 'open', page: 'panel:presets' },
    { type: 'toast', text: '已删除' },
  ]
}

function saveGroup(values) {
  const map = values !== null && typeof values === 'object' ? values : {}
  const name = clean(map['data.form.name'], 20)
  if (name === '') return { toast: '分组名称不能为空' }
  const existing = groupOf(editingGroupId)
  if (existing === null) {
    if (state.groups.length >= 23) return { toast: '分组最多 23 个' }
    state.groups.push({ id: newId('g'), name, pinned: false, createdAt: Date.now() })
  } else {
    existing.name = name
  }
  deleteGroupArmed = false
  persistBoard()
  mode = 'edit'
  return [
    { type: 'patch', id: 'presets', data: { ui: { mode: 'edit' } } },
    { type: 'open', page: 'panel:presets' },
    { type: 'toast', text: '已保存' },
  ]
}

function moveGroup(id, delta) {
  const group = groupOf(id)
  if (group === null) return { toast: '这个分组不见了' }
  const list = orderedGroups()
  const from = list.indexOf(group)
  const to = from + delta
  if (from < 0 || to < 0 || to >= list.length) return { toast: delta < 0 ? '已经是最前了' : '已经是最后了' }
  const other = list[to]
  if (other.pinned !== group.pinned) return { toast: '置顶的分组单独排在前面' }
  const a = state.groups.indexOf(group)
  const b = state.groups.indexOf(other)
  state.groups[a] = other
  state.groups[b] = group
  persistBoard()
  return { refresh: true, toast: '已移动' }
}

function toggleGroupPin() {
  const group = groupOf(editingGroupId)
  if (group === null) return { toast: '这个分组不见了' }
  group.pinned = !group.pinned
  persistBoard()
  return { refresh: true, toast: group.pinned ? '已置顶' : '已取消置顶' }
}

function askDeleteGroup() {
  if (groupOf(editingGroupId) === null) return { toast: '没有可删除的分组' }
  deleteGroupArmed = true
  return { refresh: true }
}

function removeGroup() {
  const group = groupOf(editingGroupId)
  if (group === null) return { toast: '没有可删除的分组' }
  state.groups = state.groups.filter((entry) => entry.id !== group.id)
  for (const preset of state.presets) if (preset.groupId === group.id) preset.groupId = null
  deleteGroupArmed = false
  editingGroupId = null
  persistBoard()
  mode = 'edit'
  return [
    { type: 'patch', id: 'presets', data: { ui: { mode: 'edit' } } },
    { type: 'open', page: 'panel:presets' },
    { type: 'toast', text: '已删除' },
  ]
}

function exportFile() {
  const groups = state.groups.map((group) => ({ id: group.id, name: group.name, pinned: group.pinned }))
  const byId = new Map(state.groups.map((group) => [group.id, group.name]))
  const presets = state.presets.map((preset) => ({
    id: preset.id,
    name: preset.name,
    note: preset.note,
    tags: preset.tags,
    text: preset.text,
    group: preset.groupId === null ? '' : byId.get(preset.groupId) ?? '',
    pinned: preset.pinned,
  }))
  const json = JSON.stringify({ v: 2, exportedAt: new Date().toISOString(), groups, presets }, null, 2)
  const name = `preset-board-${stamp()}.json`
  const dirs = []
  if (existsSync('/sdcard/Download')) dirs.push('/sdcard/Download/DSH-Go')
  dirs.push(join(DSH_HOME, 'dsh-go', 'exports'))
  for (const dir of dirs) {
    try {
      mkdirSync(dir, { recursive: true })
      const file = join(dir, name)
      writeFileSync(file, json)
      return { copy: file, toast: '已导出，路径已复制' }
    } catch {
      // 换下一个可写位置。
    }
  }
  return { toast: '导出失败，检查存储权限' }
}

function importBoard(raw) {
  const data = raw !== null && typeof raw === 'object' ? raw : null
  if (data === null) throw new Error('bad json')
  const sourceGroups = Array.isArray(data.groups) ? data.groups : []
  const sourcePresets = Array.isArray(data.presets) ? data.presets : Array.isArray(data) ? data : []
  const byName = new Map(state.groups.map((group) => [group.name, group]))
  for (const item of sourceGroups) {
    if (item === null || typeof item !== 'object') continue
    const name = clean(item.name, 20)
    if (name === '' || byName.has(name) || state.groups.length >= 23) continue
    const group = { id: newId('g'), name, pinned: item.pinned === true, createdAt: Date.now() }
    state.groups.push(group)
    byName.set(name, group)
  }
  let added = 0
  for (const item of sourcePresets) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const name = clean(item.name, 40)
    const text = clean(item.text, 2000)
    if (name === '' && text === '') continue
    if (state.presets.some((preset) => preset.name === name && preset.text === text)) continue
    const group = byName.get(clean(item.group, 20)) ?? null
    state.presets.push({
      id: newId('p'),
      name: name === '' ? firstLine(text).slice(0, 20) : name,
      note: clean(item.note, 80),
      tags: normalizeTags(item.tags),
      text,
      groupId: group === null ? null : group.id,
      pinned: item.pinned === true,
      createdAt: Date.now(),
    })
    added++
  }
  persistBoard()
  return added
}

const SHARE_PREFIX = 'DSHGO-PRESET:1:'

function sharePreset() {
  const preset = presetOf(editingPresetId)
  if (preset === null) return { toast: '先保存再分享' }
  const payload = {
    v: 1,
    name: preset.name,
    note: preset.note,
    tags: preset.tags,
    text: preset.text,
    group: preset.groupId === null ? '' : groupName(preset.groupId),
  }
  const code = SHARE_PREFIX + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  if (code.length > 2000) return { toast: '太长，请用导出文件分享' }
  return { copy: code, toast: '分享码已复制' }
}

function parseShare(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return null
  const body = raw.startsWith(SHARE_PREFIX)
    ? Buffer.from(raw.slice(SHARE_PREFIX.length), 'base64url').toString('utf8')
    : raw
  try {
    const data = JSON.parse(body)
    return data !== null && typeof data === 'object' ? data : null
  } catch {
    return null
  }
}

function addShared(text) {
  const data = parseShare(text)
  if (data === null) return { ok: false }
  const name = clean(data.name, 40)
  const body = clean(data.text, 2000)
  if (name === '' && body === '') return { ok: false }
  if (state.presets.some((preset) => preset.name === name && preset.text === body)) return { ok: true, added: 0 }
  let groupId = null
  const groupLabel = clean(data.group, 20)
  if (groupLabel !== '') {
    let group = state.groups.find((entry) => entry.name === groupLabel) ?? null
    if (group === null && state.groups.length < 23) {
      group = { id: newId('g'), name: groupLabel, pinned: false, createdAt: Date.now() }
      state.groups.push(group)
    }
    if (group !== null) groupId = group.id
  }
  state.presets.push({
    id: newId('p'),
    name: name === '' ? firstLine(body).slice(0, 20) : name,
    note: clean(data.note, 80),
    tags: normalizeTags(data.tags),
    text: body,
    groupId,
    pinned: data.pinned === true,
    createdAt: Date.now(),
  })
  persistBoard()
  return { ok: true, added: 1 }
}

// ───────────────────────── 注册 ─────────────────────────

export function apply(ctx) {
  ctx.inject(['dshGo'], (ctx) => {
    const dshGo = ctx.dshGo

    dshGo.on('open-presets', (scope) => {
      lastDraft = typeof scope.draft === 'string' ? scope.draft : ''
      mode = 'browse'
      return { open: 'panel:presets' }
    })

    dshGo.panel('presets', {
      view: (_scope, caps) => ({
        v: 2,
        type: 'stack',
        children: [
          {
            type: 'segmented',
            label: '模式',
            bind: 'data.ui.mode',
            options: [{ label: '浏览', value: 'browse' }, { label: '编辑', value: 'edit' }],
            onChange: 'mode-changed',
          },
          ...(mode === 'edit' ? editView(caps) : browseView(caps)),
        ],
      }),
      data: (_scope, emit) => {
        emit({ ui: { mode } })
        return () => {}
      },
      actions: {
        'mode-changed': (_scope, event) => {
          const next = event.value?.value === 'edit' ? 'edit' : 'browse'
          if (next === mode) return undefined
          mode = next
          return { patch: { ui: { mode: next } }, refresh: true }
        },
        'preset-use': (_scope, event) => usePreset(event.value?.id),
        'preset-open': (_scope, event) => {
          if (presetOf(event.value?.id) === null) return { toast: '这条预设不见了' }
          editingPresetId = event.value.id
          deletePresetArmed = false
          return { open: 'panel:preset-edit' }
        },
        'preset-new': () => {
          editingPresetId = null
          deletePresetArmed = false
          return { open: 'panel:preset-edit' }
        },
        'group-open': (_scope, event) => {
          if (groupOf(event.value?.id) === null) return { toast: '这个分组不见了' }
          editingGroupId = event.value.id
          deleteGroupArmed = false
          return { open: 'panel:group-edit' }
        },
        'group-new': () => {
          editingGroupId = null
          deleteGroupArmed = false
          return { open: 'panel:group-edit' }
        },
        'preset-add-open': () => ({ open: 'panel:preset-add' }),
        'board-export': () => exportFile(),
        'board-import': () => ({ type: 'pickFile', action: 'board-imported', maxFiles: 1 }),
        'board-imported': (_scope, event) => {
          if (event.value?.status !== 'selected') return { toast: '没有选择文件' }
          try {
            const file = event.value.files[0]
            const bytes = dshGo.readPickedFile(file.handle)
            const text = Buffer.from(bytes).toString('utf8')
            const added = importBoard(JSON.parse(text))
            return { refresh: true, toast: `已导入 ${added} 条` }
          } catch {
            return { toast: '文件不是有效的预设导出' }
          }
        },
      },
    })

    dshGo.panel('preset-edit', {
      view: () => presetEditView(),
      data: (_scope, emit) => {
        const preset = presetOf(editingPresetId)
        const length = [...(preset?.text ?? '')].length
        emit({
          form: {
            name: preset?.name ?? '',
            note: preset?.note ?? '',
            tags: preset === null ? '' : tagsLabel(preset.tags),
            group: preset?.groupId ?? 'none',
            text: preset?.text ?? '',
            pinned: preset?.pinned === true,
            countText: length >= 2000 ? `😫${length}` : '',
            countColor: length >= 2000 ? 'red' : 'gray',
          },
        })
        return () => {}
      },
      actions: {
        'preset-save': (_scope, event) => savePreset(event.value?.values),
        'content-changed': (_scope, event) => {
          const length = [...String(event.value?.value ?? '')].length
          return { patch: { form: { countText: length >= 2000 ? `😫${length}` : '', countColor: length >= 2000 ? 'red' : 'gray' } } }
        },
        'preset-share': () => sharePreset(),
        'preset-up': () => movePreset(editingPresetId, -1),
        'preset-down': () => movePreset(editingPresetId, 1),
        'preset-ask-delete': () => askDeletePreset(),
        'preset-remove': (_scope, event) => {
          if (event.value?.confirmed !== true) {
            deletePresetArmed = false
            return { refresh: true }
          }
          return removePreset()
        },
        'preset-back': () => {
          deletePresetArmed = false
          mode = 'edit'
          return [
            { type: 'patch', id: 'presets', data: { ui: { mode: 'edit' } } },
            { type: 'open', page: 'panel:presets' },
          ]
        },
      },
    })


    dshGo.panel('preset-add', {
      view: () => addView(),
      data: (_scope, emit) => {
        emit({ form: { code: '' } })
        return () => {}
      },
      actions: {
        'share-add': (_scope, event) => {
          const result = addShared(event.value?.values?.['data.form.code'] ?? '')
          if (!result.ok) return { toast: '分享码无效' }
          mode = 'edit'
          return [
            { type: 'patch', id: 'presets', data: { ui: { mode: 'edit' } } },
            { type: 'open', page: 'panel:presets' },
            { type: 'toast', text: result.added === 0 ? '这条已经在预设板里' : '已添加' },
          ]
        },
        'add-back': () => {
          mode = 'edit'
          return [
            { type: 'patch', id: 'presets', data: { ui: { mode: 'edit' } } },
            { type: 'open', page: 'panel:presets' },
          ]
        },
      },
    })

    dshGo.panel('group-edit', {
      view: () => groupEditView(),
      data: (_scope, emit) => {
        const group = groupOf(editingGroupId)
        emit({ form: { name: group?.name ?? '' } })
        return () => {}
      },
      actions: {
        'group-save': (_scope, event) => saveGroup(event.value?.values),
        'group-pin': () => toggleGroupPin(),
        'group-up': () => moveGroup(editingGroupId, -1),
        'group-down': () => moveGroup(editingGroupId, 1),
        'group-ask-delete': () => askDeleteGroup(),
        'group-remove': (_scope, event) => {
          if (event.value?.confirmed !== true) {
            deleteGroupArmed = false
            return { refresh: true }
          }
          return removeGroup()
        },
        'group-back': () => {
          deleteGroupArmed = false
          mode = 'edit'
          return [
            { type: 'patch', id: 'presets', data: { ui: { mode: 'edit' } } },
            { type: 'open', page: 'panel:presets' },
          ]
        },
      },
    })
  })
}
