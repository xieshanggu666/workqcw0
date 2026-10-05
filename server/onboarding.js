// 候选人入职交接模块
// 四阶段状态机：material 资料确认 → approval 交接审批（复用 approval_tasks：招聘负责人 → 用人经理）
//               → report 报到（同事务回写 Offer accepted→joined）→ handover 试用交接（招聘负责人备齐、用人经理逐项确认 → completed）
// 候选人侧操作（资料确认）由招聘负责人电话/短信确认后代为执行，候选人通知投递招聘负责人角色。
// 与主流程的协同点：
//  - 审批：提交/通过/退回/重提/撤销由 index.js 的审批端点调用本模块生命周期钩子，同一事务内流转
//  - 报到：审批通过后报到动作调用主流程注入的 markOfferJoined，与 Offer 页「确认入职」走同一套回写
//  - 回退：录用阶段异常回退 / 危机回退 / 已接受 Offer 撤回，同步取消交接（危机场景上链并由调用方通知）
import express from 'express'
import db, { ts } from './db.js'
import { auditPassive, findActiveIncidentForApp } from './crisis.js'

export const router = express.Router()

// ---------------- 通用工具 ----------------
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }
const parseJSON = (s, d) => { try { return JSON.parse(s || '') ?? d } catch { return d } }
const httpError = (status, code, msg) => Object.assign(new Error(msg), { status, code })
const badRequest = (m, c = 'invalid') => { throw httpError(400, c, m) }
const conflict = (m, c = 'conflict') => { throw httpError(409, c, m) }
const forbidden = (m, c = 'forbidden') => { throw httpError(403, c, m) }
const notFound = (m = '入职交接记录不存在', c = 'not_found') => { throw httpError(404, c, m) }
const wrap = fn => (req, res, next) => { try { return fn(req, res, next) } catch (e) { next(e) } }

function tx(fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

function currentUser(req) {
  const id = String(req.headers['x-user-id'] || '')
  const u = id ? db.prepare('SELECT * FROM users WHERE id=?').get(id) : null
  return u || db.prepare("SELECT * FROM users WHERE role='recruiter' ORDER BY id LIMIT 1").get()
}
const checkVersion = (row, expected) => {
  if (expected !== undefined && expected !== null && expected !== '' && num(expected) !== num(row.version)) {
    conflict('交接状态已被其他操作更新，请刷新后重试', 'version_conflict')
  }
}

export const ROLE_LABEL = { recruiter: '招聘负责人', interviewer: '面试官', hiring_manager: '用人经理' }
export const OB_STATUS = ['material', 'approval', 'report', 'handover', 'completed', 'cancelled']
export const STATUS_LABEL = {
  material: '资料确认', approval: '交接审批', report: '报到',
  handover: '试用交接', completed: '交接完成', cancelled: '已取消'
}
export const PHASES = [
  { key: 'material', label: '资料确认', icon: '📋' },
  { key: 'approval', label: '审批', icon: '✅' },
  { key: 'report', label: '报到', icon: '🏢' },
  { key: 'handover', label: '试用交接', icon: '🤝' }
]
export const LOG_ACTION_LABEL = {
  start: '发起交接', material_update: '资料确认', submit: '提交审批', approve: '审批通过',
  return: '审批退回', resubmit: '修改重提', cancel_task: '撤销审批',
  report: '确认报到', delay: '报到延期', ready: '交接备齐', confirm: '逐项确认',
  complete: '交接完成', cancel: '取消交接'
}

// 资料确认清单项与试用交接清单项（发起时初始化；历史交接沿用同一默认项）
export const MATERIAL_ITEMS = [
  { key: 'identity', label: '身份证/学历证明' },
  { key: 'resume', label: '纸质简历与照片' },
  { key: 'offer_letter', label: 'Offer 回执签字' },
  { key: 'bank', label: '银行卡与社保信息' },
  { key: 'physical', label: '入职体检报告' },
  { key: 'release', label: '离职证明' }
]
export const HANDOVER_ITEMS = [
  { key: 'account', label: '账号与权限开通（邮箱/代码库/内部系统）' },
  { key: 'equipment', label: '办公设备与工位准备' },
  { key: 'mentor', label: '导师/带教安排' },
  { key: 'training', label: '入职培训日程' },
  { key: 'plan', label: '试用期目标与考核计划' }
]
const defaultMaterial = () => MATERIAL_ITEMS.map(i => ({ ...i, confirmed: 0 }))
const defaultHandover = () => HANDOVER_ITEMS.map(i => ({ ...i, ready: 0, confirmed: 0 }))

// 主流程注入：报到时把 Offer 回写为 joined（与 Offer 页确认入职同一条业务路径）
let core = null
export function bindOnboardingCore(c) { core = c }

// ---------------- 通知 / 留痕 ----------------
function notifyRole(role, type, title, body, appId = 0) {
  if (!role) return
  db.prepare(`INSERT INTO notifications(recipient_role,type,title,body,application_id,is_read,created_at)
              VALUES(?,?,?,?,?,0,?)`).run(role, type, title, body, num(appId), ts())
}
function addLog(ob, { phase = '', action, actor, content = '', detail = {} }) {
  db.prepare(`INSERT INTO onboarding_logs(onboarding_id,application_id,phase,action,actor_id,actor_name,actor_role,content,detail,created_at)
              VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(ob.id, ob.application_id, phase || ob.status, action,
      actor?.id || '', actor?.name || '', actor?.role || '', content, JSON.stringify(detail), ts())
}

// ---------------- 数据读取 ----------------
function getOnboarding(id) {
  const ob = db.prepare('SELECT * FROM onboardings WHERE id=?').get(num(id))
  if (!ob) notFound()
  return ob
}
export function activeOnboardingOfApp(appId) {
  return db.prepare("SELECT * FROM onboardings WHERE application_id=? AND status!='cancelled' ORDER BY id DESC LIMIT 1")
    .get(num(appId)) || null
}
function materialItems(ob) { return parseJSON(ob.material_items, defaultMaterial()) }
function handoverItems(ob) { return parseJSON(ob.handover_items, defaultHandover()) }
const allConfirmed = items => items.length > 0 && items.every(i => i.confirmed)

// ---------------- 交接生命周期核心（必须在调用方事务内执行） ----------------
// 发起交接：仅「录用」阶段（已接受/已入职 Offer）可发起；一个应聘仅一条有效交接
export function startOnboardingCore(appId, user, { expectedOnboardAt = '' } = {}) {
  const a = db.prepare('SELECT * FROM applications WHERE id=?').get(num(appId))
  if (!a) badRequest('关联应聘记录不存在', 'app_missing')
  if (a.stage !== 'hired') conflict('仅已录用（候选人已接受 Offer）的人员可以发起入职交接', 'not_hired')
  const of = db.prepare('SELECT * FROM offers WHERE application_id=? ORDER BY id DESC LIMIT 1').get(a.id)
  if (!of || !['accepted', 'joined'].includes(of.status)) {
    conflict('候选人尚未接受 Offer，不能发起入职交接', 'offer_not_accepted')
  }
  if (activeOnboardingOfApp(a.id)) conflict('该候选人已存在进行中的入职交接', 'onboarding_duplicate')

  const stamp = ts()
  // 已入职（历史路径直接确认过入职）的人员：预计报到时间沿用 Offer 入职时间，报到步骤幂等不再回写
  const expected = expectedOnboardAt || of.joined_at || of.due || stamp
  const r = db.prepare(`INSERT INTO onboardings
    (application_id,status,material_items,expected_onboard_at,created_by,created_at,updated_at,version)
    VALUES(?, 'material', ?, ?, ?, ?, ?,1)`)
    .run(a.id, JSON.stringify(defaultMaterial()), expected, user?.id || '', stamp, stamp)
  const ob = getOnboarding(Number(r.lastInsertRowid))
  addLog(ob, { phase: 'material', action: 'start', actor: user, content: '发起入职交接，进入资料确认阶段' })
  auditPassive({
    category: 'action', action: 'onboarding.start', actor: user, applicationId: a.id,
    refType: 'onboarding', refId: ob.id, summary: '发起入职交接（资料确认）',
    detail: { onboarding_id: ob.id, expected_onboard_at: expected, offer_status: of.status }
  })
  return ob
}

// 审批提交钩子：由审批端点在任务落库后调用——资料确认必须完成，交接进入审批阶段
function hookSubmit(taskId, app, user) {
  const ob = activeOnboardingOfApp(app.id)
  if (!ob) conflict('请先发起入职交接', 'onboarding_missing')
  if (ob.status !== 'material') conflict('该交接当前不在资料确认阶段，无需重复提交审批', 'onboarding_status')
  const items = materialItems(ob)
  if (!ob.candidate_confirmed || !allConfirmed(items)) {
    badRequest('请先逐项确认入职资料并取得候选人本人确认，再提交审批', 'material_incomplete')
  }
  db.prepare("UPDATE onboardings SET status='approval',approval_task_id=?,updated_at=?,version=version+1 WHERE id=?")
    .run(taskId, ts(), ob.id)
  ob.status = 'approval'; ob.approval_task_id = taskId; ob.version = num(ob.version) + 1
  addLog(ob, {
    phase: 'approval', action: 'submit', actor: user,
    content: '资料确认完成，提交入职交接审批（用人经理审批）',
    detail: { task_id: taskId, expected_onboard_at: ob.expected_onboard_at }
  })
  auditPassive({
    category: 'decision', action: 'onboarding.submit', actor: user, applicationId: app.id,
    refType: 'approval', refId: taskId, summary: '提交入职交接审批', detail: { task_id: taskId, onboarding_id: ob.id }
  })
  return ob
}

// 终审通过执行钩子：交接审批通过 → 进入报到阶段（不在此处回写 Offer，报到动作才回写）
function hookExecute(task, actor) {
  const ob = activeOnboardingOfApp(task.application_id)
  if (!ob || ob.status !== 'approval' || num(ob.approval_task_id) !== num(task.id)) {
    conflict('入职交接状态已变化（已取消或不在审批阶段），审批无法回写', 'onboarding_drift')
  }
  db.prepare("UPDATE onboardings SET status='report',updated_at=?,version=version+1 WHERE id=?").run(ts(), ob.id)
  ob.status = 'report'; ob.version = num(ob.version) + 1
  addLog(ob, {
    phase: 'approval', action: 'approve', actor,
    content: '用人经理终审通过，进入报到阶段，请安排候选人按期报到',
    detail: { task_id: task.id }
  })
  auditPassive({
    category: 'decision', action: 'onboarding.approve', actor, applicationId: task.application_id,
    refType: 'approval', refId: task.id, summary: '入职交接审批通过，进入报到阶段',
    detail: { task_id: task.id, onboarding_id: ob.id }
  })
  notifyRole('recruiter', 'onboarding_approved', '🧳 入职交接审批已通过',
    `「交接 #${ob.id}」用人经理已审批通过，请联系候选人按期报到并确认`, task.application_id)
  return { desc: `入职交接审批已通过，进入「报到」阶段`, version: ob.version }
}

// 审批退回钩子：交接回到资料确认，招聘负责人可补充资料后重新提交
function hookReturned(task, user, note) {
  const ob = activeOnboardingOfApp(task.application_id)
  if (!ob || ob.status !== 'approval' || num(ob.approval_task_id) !== num(task.id)) return null
  db.prepare("UPDATE onboardings SET status='material',updated_at=?,version=version+1 WHERE id=?").run(ts(), ob.id)
  ob.status = 'material'; ob.version = num(ob.version) + 1
  addLog(ob, {
    phase: 'approval', action: 'return', actor: user,
    content: `审批被退回，交接回到资料确认：${note || ''}`, detail: { task_id: task.id, note }
  })
  auditPassive({
    category: 'decision', action: 'onboarding.return', actor: user, applicationId: task.application_id,
    refType: 'approval', refId: task.id, summary: `入职交接审批被退回：${note}`, detail: { task_id: task.id, note }
  })
  return ob
}

// 退回后重提钩子：按最新资料重新校验并进入审批
function hookResubmitted(task, user) {
  const ob = activeOnboardingOfApp(task.application_id)
  if (!ob || ob.status !== 'material') conflict('交接状态已变化，不能重新提交审批', 'onboarding_status')
  const items = materialItems(ob)
  if (!ob.candidate_confirmed || !allConfirmed(items)) {
    badRequest('请重新逐项确认入职资料并取得候选人确认后再提交', 'material_incomplete')
  }
  db.prepare("UPDATE onboardings SET status='approval',approval_task_id=?,updated_at=?,version=version+1 WHERE id=?")
    .run(task.id, ts(), ob.id)
  ob.status = 'approval'; ob.approval_task_id = task.id; ob.version = num(ob.version) + 1
  addLog(ob, { phase: 'approval', action: 'resubmit', actor: user, content: '资料补充后重新提交入职交接审批', detail: { task_id: task.id } })
  auditPassive({
    category: 'decision', action: 'onboarding.resubmit', actor: user, applicationId: task.application_id,
    refType: 'approval', refId: task.id, summary: '入职交接审批修改重提', detail: { task_id: task.id }
  })
  return ob
}

// 申请人撤销审批任务：交接回到资料确认（区别于整个交接取消，候选人仍在录用流程内）
function hookTaskCancelled(task, user, note) {
  const ob = activeOnboardingOfApp(task.application_id)
  if (!ob || ob.status !== 'approval' || num(ob.approval_task_id) !== num(task.id)) return null
  db.prepare("UPDATE onboardings SET status='material',updated_at=?,version=version+1 WHERE id=?").run(ts(), ob.id)
  ob.status = 'material'; ob.version = num(ob.version) + 1
  addLog(ob, {
    phase: 'approval', action: 'cancel_task', actor: user,
    content: `交接审批申请已撤销，回到资料确认：${note || ''}`, detail: { task_id: task.id }
  })
  auditPassive({
    category: 'decision', action: 'onboarding.cancel_task', actor: user, applicationId: task.application_id,
    refType: 'approval', refId: task.id, summary: '入职交接审批申请撤销，回到资料确认', detail: { task_id: task.id, note }
  })
  return ob
}

export const onboardingHooks = {
  submit: hookSubmit, execute: hookExecute, returned: hookReturned,
  resubmitted: hookResubmitted, taskCancelled: hookTaskCancelled
}

// 同步撤销交接关联的待审批任务（整单取消/流程回退时）：直接补写审批留痕，与审批中心撤销口径一致
function cancelLinkedTask(ob, actor, reason) {
  const taskId = num(ob.approval_task_id)
  if (!taskId) return null
  const t = db.prepare('SELECT * FROM approval_tasks WHERE id=?').get(taskId)
  if (!t || t.status !== 'pending') return null
  const stamp = ts()
  db.prepare("UPDATE approval_tasks SET status='cancelled',decided_at=?,version=version+1 WHERE id=?").run(stamp, taskId)
  db.prepare(`INSERT INTO approval_steps(task_id,step_no,role,action,actor_id,actor_name,note,acted_at)
              VALUES(?,?, 'cancel', ?,?,?,?)`)
    .run(taskId, -1, actor?.id || '', actor?.name || '', reason || '入职交接已取消，审批任务同步撤销', stamp)
  return { id: taskId }
}

// 整单取消内部实现（手动取消 / 主流程回退 / 危机回退共用）：
// silent=true 时不自行通知/上链，由危机模块统一追加审计条目与跨角色通知
function cancelInternal(ob, { actor, reason = '', silent = false, via = 'manual' } = {}) {
  if (!ob || ob.status === 'cancelled') return null
  if (ob.status === 'completed') return null
  const from = ob.status
  const stamp = ts()
  const linked = (from === 'approval') ? cancelLinkedTask(ob, actor, reason) : null
  db.prepare(`UPDATE onboardings SET status='cancelled',cancel_reason=?,cancelled_at=?,updated_at=?,version=version+1 WHERE id=?`)
    .run(reason, stamp, stamp, ob.id)
  addLog(ob, {
    phase: from, action: 'cancel', actor,
    content: `入职交接取消（${STATUS_LABEL[from]} → 已取消）：${reason || '未填写原因'}`,
    detail: { from, reason, via, linked_task: linked?.id || 0 }
  })
  if (!silent) {
    auditPassive({
      category: 'action', action: 'onboarding.cancel', actor, applicationId: ob.application_id,
      refType: 'onboarding', refId: ob.id,
      summary: `入职交接随流程变动取消：${STATUS_LABEL[from]} → 已取消`,
      detail: { onboarding_id: ob.id, from, reason, via }
    })
    notifyRole('recruiter', 'onboarding_cancelled', '🚫 入职交接已取消',
      `「交接 #${ob.id}」因「${reason || '流程变动'}」取消（原阶段：${STATUS_LABEL[from]}）`, ob.application_id)
    notifyRole('hiring_manager', 'onboarding_cancelled', '🚫 入职交接已取消',
      `「交接 #${ob.id}」因「${reason || '流程变动'}」取消（原阶段：${STATUS_LABEL[from]}）`, ob.application_id)
  }
  return { id: ob.id, from, linkedTask: linked?.id || 0 }
}

// 主流程/危机模块回退录用阶段时调用（在调用方事务内）；silent 由危机场景使用
export function cancelOnboardingForFlow(appId, opts = {}) {
  const ob = activeOnboardingOfApp(appId)
  if (!ob) return null
  return cancelInternal(ob, opts)
}

// ---------------- 路由 ----------------
// 发起交接
router.post('/start', wrap((req, res) => {
  const user = currentUser(req)
  if (user.role !== 'recruiter') forbidden('发起入职交接需「招聘负责人」身份', 'role_not_allowed')
  const b = req.body || {}
  const out = tx(() => {
    const ob = startOnboardingCore(num(b.application_id), user, { expectedOnboardAt: String(b.expected_onboard_at || '') })
    return { ok: true, id: ob.id, status: ob.status }
  })
  res.json(out)
}))

// 资料确认：逐项勾选（候选人侧由招聘负责人代为确认）+ 候选人本人确认位 + 预计报到时间
router.post('/:id/material', wrap((req, res) => {
  const user = currentUser(req)
  if (user.role !== 'recruiter') forbidden('资料确认由招聘负责人代为操作', 'role_not_allowed')
  const b = req.body || {}
  const out = tx(() => {
    const ob = getOnboarding(num(req.params.id))
    checkVersion(ob, b.version)
    if (ob.status !== 'material') conflict('仅资料确认阶段可以更新资料；审批退回后可继续补充', 'onboarding_status')
    const stamp = ts()
    const items = materialItems(ob)

    // 兼容两种入参：{items:{key:true}} 或 {items:[{key,confirmed}]}
    const patch = {}
    if (b.items && !Array.isArray(b.items)) Object.assign(patch, b.items)
    if (Array.isArray(b.items)) b.items.forEach(i => { if (i?.key) patch[i.key] = !!i.confirmed })
    let changed = []
    Object.entries(patch).forEach(([key, val]) => {
      const item = items.find(i => i.key === key)
      if (!item) return
      const v = val ? 1 : 0
      if (num(item.confirmed) !== v) {
        item.confirmed = v
        item.by = v ? user.name : ''
        item.at = v ? stamp : ''
        changed.push(item.label)
      }
    })
    if (b.note !== undefined) db.prepare('UPDATE onboardings SET material_note=? WHERE id=?').run(String(b.note), ob.id)
    if (b.expected_onboard_at !== undefined) {
      db.prepare('UPDATE onboardings SET expected_onboard_at=? WHERE id=?').run(String(b.expected_onboard_at), ob.id)
      ob.expected_onboard_at = String(b.expected_onboard_at)
    }

    // 候选人本人确认位：置 1 前必须全部资料项已确认；允许撤回重核
    let candConfirmed = num(ob.candidate_confirmed) ? 1 : 0
    if (b.candidate_confirmed !== undefined) {
      candConfirmed = b.candidate_confirmed ? 1 : 0
      if (candConfirmed && !allConfirmed(items)) badRequest('还有资料项未确认，不能取得候选人确认', 'material_incomplete')
      db.prepare('UPDATE onboardings SET candidate_confirmed=?, candidate_confirmed_at=? WHERE id=?')
        .run(candConfirmed, candConfirmed ? stamp : '', ob.id)
      ob.candidate_confirmed = candConfirmed
    }
    db.prepare('UPDATE onboardings SET material_items=?,updated_at=?,version=version+1 WHERE id=?')
      .run(JSON.stringify(items), stamp, ob.id)
    if (changed.length || b.candidate_confirmed !== undefined || b.expected_onboard_at !== undefined) {
      addLog(ob, {
        phase: 'material', action: 'material_update', actor: user,
        content: candConfirmed && b.candidate_confirmed !== undefined
          ? `候选人已确认全部资料无误（更新项：${changed.join('、') || '无'}）`
          : `更新资料确认：${changed.join('、') || '候选人确认位调整'}`,
        detail: { changed, candidate_confirmed: candConfirmed, expected_onboard_at: ob.expected_onboard_at }
      })
    }
    auditPassive({
      category: 'action', action: 'onboarding.material', actor: user, applicationId: ob.application_id,
      refType: 'onboarding', refId: ob.id, summary: '入职资料确认更新',
      detail: { changed, candidate_confirmed: candConfirmed }
    })
    return { ok: true, status: 'material', items, candidate_confirmed: !!candConfirmed, version: num(ob.version) + 1 }
  })
  res.json(out)
}))

// 报到：审批通过后招聘负责人确认候选人到岗；同一事务把 Offer 回写为 joined，随后进入试用交接
router.post('/:id/report', wrap((req, res) => {
  const user = currentUser(req)
  if (user.role !== 'recruiter') forbidden('报到确认由招聘负责人操作', 'role_not_allowed')
  const b = req.body || {}
  const out = tx(() => {
    const ob = getOnboarding(num(req.params.id))
    checkVersion(ob, b.version)
    if (ob.status !== 'report') conflict('仅报到阶段可以确认报到', 'onboarding_status')
    const stamp = ts()
    const reportAt = String(b.report_at || b.expected_onboard_at || ts())

    // 与 Offer 页「确认入职」共用主流程回写函数；已入职（历史直接确认）幂等跳过
    let offerJoined = false, alreadyJoined = false
    if (core?.markOfferJoined) {
      const r = core.markOfferJoined(ob.application_id, { joinedAt: reportAt, operator: user.name })
      offerJoined = !!r.changed
      alreadyJoined = !!r.already
    }

    db.prepare(`UPDATE onboardings SET status='handover',report_at=?,report_note=?,
                handover_items=CASE WHEN handover_items='[]' OR handover_items='' THEN ? ELSE handover_items END,
                updated_at=?,version=version+1 WHERE id=?`)
      .run(reportAt, String(b.note || ''), JSON.stringify(defaultHandover()), stamp, ob.id)
    addLog(ob, {
      phase: 'report', action: 'report', actor: user,
      content: `候选人已于 ${reportAt} 报到${offerJoined ? '，Offer 已回写为「已入职」' : alreadyJoined ? '（Offer 此前已确认入职，幂等跳过）' : ''}，进入试用交接`,
      detail: { report_at: reportAt, offer_joined: offerJoined, already_joined: alreadyJoined, note: String(b.note || '') }
    })
    auditPassive({
      category: 'action', action: 'onboarding.report', actor: user, applicationId: ob.application_id,
      refType: 'onboarding', refId: ob.id,
      summary: `候选人报到，Offer 回写已入职，进入试用交接`,
      detail: { report_at: reportAt, offer_joined: offerJoined, already_joined: alreadyJoined }
    })
    notifyRole('hiring_manager', 'onboarding_reported', '🏢 候选人已报到，进入试用交接',
      `「交接 #${ob.id}」候选人已于 ${reportAt} 报到，请招聘负责人备齐交接项后由您逐项确认`, ob.application_id)
    return { ok: true, status: 'handover', offer_joined: offerJoined, version: num(ob.version) + 1 }
  })
  res.json(out)
}))

// 报到延期：报到阶段候选人无法按期到岗，登记新的预计报到时间（必填原因），通知用人经理
router.post('/:id/delay', wrap((req, res) => {
  const user = currentUser(req)
  if (user.role !== 'recruiter') forbidden('报到延期由招聘负责人登记', 'role_not_allowed')
  const b = req.body || {}
  const out = tx(() => {
    const ob = getOnboarding(num(req.params.id))
    checkVersion(ob, b.version)
    if (ob.status !== 'report') conflict('仅报到阶段可以登记延期', 'onboarding_status')
    const target = String(b.expected_onboard_at || '')
    const reason = String(b.reason || '').trim()
    if (!target) badRequest('请选择新的预计报到时间', 'time_required')
    if (!reason) badRequest('报到延期必须填写原因', 'reason_required')
    const before = ob.expected_onboard_at
    db.prepare(`UPDATE onboardings SET expected_onboard_at=?,delay_count=delay_count+1,updated_at=?,version=version+1 WHERE id=?`)
      .run(target, ts(), ob.id)
    addLog(ob, {
      phase: 'report', action: 'delay', actor: user,
      content: `报到延期：${before || '未定'} → ${target}；原因：${reason}`,
      detail: { from: before, to: target, reason, delay_count: num(ob.delay_count) + 1 }
    })
    auditPassive({
      category: 'action', action: 'onboarding.delay', actor: user, applicationId: ob.application_id,
      refType: 'onboarding', refId: ob.id, summary: `入职报到延期至 ${target}`, detail: { from: before, to: target, reason }
    })
    notifyRole('hiring_manager', 'onboarding_delayed', '⏳ 候选人报到延期',
      `「交接 #${ob.id}」预计报到时间由 ${before || '未定'} 调整为 ${target}；原因：${reason}`, ob.application_id)
    return { ok: true, status: 'report', expected_onboard_at: target, delay_count: num(ob.delay_count) + 1, version: num(ob.version) + 1 }
  })
  res.json(out)
}))

// 试用交接：招聘负责人切换「备齐」、用人经理切换「确认」；逐项操作、逐项留痕通知
router.post('/:id/handover', wrap((req, res) => {
  const user = currentUser(req)
  if (user.role === 'interviewer') forbidden('用人经理/招聘负责人之外的角色不参与试用交接', 'role_not_allowed')
  const b = req.body || {}
  const out = tx(() => {
    const ob = getOnboarding(num(req.params.id))
    checkVersion(ob, b.version)
    if (ob.status !== 'handover') conflict('仅试用交接阶段可以更新交接项', 'onboarding_status')
    const key = String(b.key || '')
    const items = handoverItems(ob)
    const item = items.find(i => i.key === key)
    if (!item) badRequest('交接项不存在', 'item_missing')
    const stamp = ts()
    const beforeReady = num(item.ready) ? 1 : 0
    let action = '', content = ''

    if (user.role === 'recruiter') {
      if (b.ready === undefined && b.note === undefined) badRequest('缺少更新内容', 'no_change')
      if (b.note !== undefined) item.note = String(b.note)
      if (b.ready !== undefined) {
        const ready = b.ready ? 1 : 0
        if (!ready && num(item.confirmed)) conflict('用人经理已确认该项，请先由用人经理取消确认再撤回备齐', 'item_confirmed')
        item.ready = ready
        item.ready_by = ready ? user.name : ''
        item.ready_at = ready ? stamp : ''
        if (!ready) { item.confirmed = 0; item.confirmed_by = ''; item.confirmed_at = '' }
        action = 'ready'
        content = `交接项「${item.label}」${ready ? '已备齐' : '撤回备齐'}`
      }
    } else {
      // 用人经理：逐项确认/取消确认（取消确认便于补充后重核）
      if (b.confirmed === undefined && b.confirm === undefined) badRequest('用人经理仅可确认交接项', 'no_change')
      const confirmed = b.confirmed !== undefined ? !!b.confirmed : !!b.confirm
      if (!num(item.ready)) badRequest(`交接项「${item.label}」尚未备齐，不能确认`, 'item_not_ready')
      item.confirmed = confirmed ? 1 : 0
      item.confirmed_by = confirmed ? user.name : ''
      item.confirmed_at = confirmed ? stamp : ''
      action = 'confirm'
      content = `用人经理${confirmed ? '确认' : '取消确认'}交接项「${item.label}」`
    }

    db.prepare("UPDATE onboardings SET handover_items=?,updated_at=?,version=version+1 WHERE id=?")
      .run(JSON.stringify(items), stamp, ob.id)
    if (action) {
      addLog(ob, { phase: 'handover', action, actor: user, content, detail: { key, item: item.label } })
      auditPassive({
        category: 'action', action: action === 'ready' ? 'onboarding.ready' : 'onboarding.confirm',
        actor: user, applicationId: ob.application_id, refType: 'onboarding', refId: ob.id,
        summary: content, detail: { key, ready: num(item.ready), confirmed: num(item.confirmed) }
      })
    }

    const readyCount = items.filter(i => num(i.ready)).length
    const confirmedCount = items.filter(i => num(i.confirmed)).length
    // 备齐位全部补齐：通知用人经理逐项确认；用人经理每次确认：通知招聘负责人进度
    if (action === 'ready' && !beforeReady && readyCount === items.length) {
      notifyRole('hiring_manager', 'onboarding_ready', '🤝 试用交接项已全部备齐',
        `「交接 #${ob.id}」${items.length} 项交接内容已全部备齐，请逐项确认并完成交接`, ob.application_id)
    }
    if (action === 'confirm') {
      notifyRole('recruiter', 'onboarding_confirmed', '✅ 用人经理更新交接确认',
        `「交接 #${ob.id}」${user.name}${num(item.confirmed) ? '已确认' : '取消确认'}「${item.label}」（${items.filter(i => num(i.confirmed)).length}/${items.length}）`,
        ob.application_id)
    }
    return {
      ok: true, items, ready_count: readyCount, confirmed_count: confirmedCount,
      total: items.length, version: num(ob.version) + 1
    }
  })
  res.json(out)
}))

// 完成交接：用人经理在全部交接项备齐并确认后结案
router.post('/:id/complete', wrap((req, res) => {
  const user = currentUser(req)
  if (user.role !== 'hiring_manager') forbidden('试用交接完成需「用人经理」确认', 'role_not_allowed')
  const b = req.body || {}
  const out = tx(() => {
    const ob = getOnboarding(num(req.params.id))
    checkVersion(ob, b.version)
    if (ob.status !== 'handover') conflict('仅试用交接阶段可以完成交接', 'onboarding_status')
    const items = handoverItems(ob)
    const unready = items.filter(i => !num(i.ready)).map(i => i.label)
    const unconfirmed = items.filter(i => !num(i.confirmed)).map(i => i.label)
    if (unready.length || unconfirmed.length) {
      badRequest(`仍有交接项未完成（未备齐：${unready.join('、') || '无'}；未确认：${unconfirmed.join('、') || '无'}）`, 'handover_incomplete')
    }
    const stamp = ts()
    db.prepare("UPDATE onboardings SET status='completed',completed_at=?,updated_at=?,version=version+1 WHERE id=?")
      .run(stamp, stamp, ob.id)
    addLog(ob, {
      phase: 'handover', action: 'complete', actor: user,
      content: `全部 ${items.length} 项交接内容备齐并确认，入职交接完成`, detail: { total: items.length }
    })
    auditPassive({
      category: 'action', action: 'onboarding.complete', actor: user, applicationId: ob.application_id,
      refType: 'onboarding', refId: ob.id, summary: '入职交接全部完成', detail: { total: items.length }
    })
    notifyRole('recruiter', 'onboarding_completed', '🎉 入职交接已完成',
      `「交接 #${ob.id}」用人经理已确认全部交接项，候选人正式进入试用期`, ob.application_id)
    return { ok: true, status: 'completed', completed_at: stamp, version: num(ob.version) + 1 }
  })
  res.json(out)
}))

// 手动取消交接：招聘负责人在任一未完成阶段取消（审批中同步撤销审批任务）
router.post('/:id/cancel', wrap((req, res) => {
  const user = currentUser(req)
  if (user.role !== 'recruiter') forbidden('取消交接需「招聘负责人」身份', 'role_not_allowed')
  const b = req.body || {}
  const reason = String(b.reason || '').trim()
  if (!reason) badRequest('取消交接必须填写原因', 'reason_required')
  const out = tx(() => {
    const ob = getOnboarding(num(req.params.id))
    checkVersion(ob, b.version)
    const r = cancelInternal(ob, { actor: user, reason, via: 'manual_cancel' })
    if (!r) conflict('该交接已结束，不能取消', 'onboarding_closed')
    return { ok: true, status: 'cancelled', ...r }
  })
  res.json(out)
}))

// ---------------- 状态汇总（挂载到 /api/state） ----------------
export function getOnboardingState() {
  const logs = db.prepare('SELECT * FROM onboarding_logs ORDER BY id ASC').all()
  const rows = db.prepare('SELECT * FROM onboardings ORDER BY id DESC').all().map(ob => {
    const a = db.prepare(`SELECT ap.*, c.name candidate_name, p.name position_name, p.dept dept_name,
                                 o.status offer_status
                          FROM applications ap
                          JOIN candidates c ON c.id=ap.candidate_id
                          JOIN positions p ON p.id=ap.position_id
                          LEFT JOIN offers o ON o.id=(SELECT id FROM offers WHERE application_id=ap.id ORDER BY id DESC LIMIT 1)
                          WHERE ap.id=?`).get(ob.application_id)
    const mItems = parseJSON(ob.material_items, defaultMaterial())
    const hItems = parseJSON(ob.handover_items, defaultHandover())
    const active = !['cancelled', 'completed'].includes(ob.status)
    const task = num(ob.approval_task_id)
      ? db.prepare('SELECT id,status FROM approval_tasks WHERE id=?').get(num(ob.approval_task_id))
      : null
    return {
      ...ob,
      candidate_confirmed: !!ob.candidate_confirmed,
      delay_count: num(ob.delay_count),
      approval_task_id: num(ob.approval_task_id),
      approval_task_status: task?.status || '',
      active,
      status_label: STATUS_LABEL[ob.status] || ob.status,
      candidate: a?.candidate_name || '',
      position: a?.position_name || '',
      dept: a?.dept_name || '',
      app_stage: a?.stage || '',
      offer_status: a?.offer_status || '',
      material_items: mItems,
      handover_items: hItems,
      material_confirmed_count: mItems.filter(i => num(i.confirmed)).length,
      material_total: mItems.length,
      ready_count: hItems.filter(i => num(i.ready)).length,
      confirmed_count: hItems.filter(i => num(i.confirmed)).length,
      handover_total: hItems.length,
      logs: logs.filter(l => l.onboarding_id === ob.id).map(l => ({
        ...l, action_label: LOG_ACTION_LABEL[l.action] || l.action
      }))
    }
  })
  return { onboardings: rows }
}
