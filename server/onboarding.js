// 候选人入职交接模块
// 已录用（Offer 已接受）候选人由 招聘负责人 / 用人经理 / 候选人（招聘负责人代为确认）协同，经历：
//   资料确认(profile) → 审批(approval) → 报到(checkin) → 试用交接(handover) → 完成(done)
// - 资料确认：招聘负责人维护入职资料清单并与候选人逐项确认（候选人侧无账号，沿用预约模块的代操作惯例）
// - 审批：招聘负责人提交 → 用人经理审批，可退回（退回后回到资料确认，修改后重提，历史留痕保留）
// - 报到：招聘负责人确认候选人报到；同一事务复用主流程的 Offer「确认入职」状态机回写已录用流程
// - 试用交接：用人经理（HR 协同）登记带教导师/账号/设备/培训等事项并完成交接
// 撤销/中止(no_show/系统回退)后同一应聘可重新发起；已录用流程回退（Offer 撤回/异常回退）被动中止进行中的交接单。
import express from 'express'
import db, { ts } from './db.js'
import { auditPassive } from './crisis.js'

export const router = express.Router()

// ---------------- 通用工具 ----------------
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }
const parseJSON = (s, d) => { try { return JSON.parse(s || '') ?? d } catch { return d } }
const httpError = (status, code, msg) => Object.assign(new Error(msg), { status, code })
const badRequest = (m, c = 'invalid') => { throw httpError(400, c, m) }
const conflict = (m, c = 'conflict') => { throw httpError(409, c, m) }
const forbidden = (m, c = 'forbidden') => { throw httpError(403, c, m) }
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

export const PHASES = ['profile', 'approval', 'checkin', 'handover']
const ACTIVE_PHASES = ['profile', 'approval', 'checkin', 'handover']
export const PHASE_LABEL = {
  profile: '资料确认', approval: '审批', checkin: '报到', handover: '试用交接',
  done: '交接完成', cancelled: '已中止'
}
const ACTION_LABEL = {
  create: '发起交接', profile_update: '更新资料', candidate_confirm: '候选人确认资料',
  submit: '提交审批', approve: '审批通过', return: '审批退回', resubmit: '修改重提',
  checkin: '确认报到', no_show: '未报到中止', handover_update: '交接事项更新',
  complete: '试用交接完成', cancel: '撤销交接', system_cancel: '流程回退中止', migrate: '历史数据补录'
}
const PARTY_LABEL = { candidate: '候选人', recruiter: '招聘负责人', hiring_manager: '用人经理', system: '系统' }

// 入职必交材料默认清单（社保/公积金转移单可选）
const DEFAULT_MATERIALS = [
  { key: 'id_card', name: '身份证复印件', required: 1, status: 'pending', note: '' },
  { key: 'edu_cert', name: '学历/学位证明', required: 1, status: 'pending', note: '' },
  { key: 'resign_cert', name: '原单位离职证明', required: 1, status: 'pending', note: '' },
  { key: 'photo', name: '一寸证件照', required: 1, status: 'pending', note: '' },
  { key: 'bank_card', name: '银行卡信息（发薪）', required: 1, status: 'pending', note: '' },
  { key: 'medical', name: '入职体检报告', required: 1, status: 'pending', note: '' },
  { key: 'social_security', name: '社保/公积金转移单', required: 0, status: 'pending', note: '' }
]

// 报到后自动生成的试用交接清单
const DEFAULT_HANDOVER = [
  { key: 'mentor', title: '指定带教导师', owner: '用人经理', status: 'pending', note: '' },
  { key: 'account', title: '系统账号开通（邮箱/代码库/VPN）', owner: 'HR / IT', status: 'pending', note: '' },
  { key: 'device', title: '办公设备与工牌领取', owner: '行政 / IT', status: 'pending', note: '' },
  { key: 'training', title: '入职培训与制度宣导', owner: 'HR', status: 'pending', note: '' },
  { key: 'team_intro', title: '团队介绍与首周工作安排', owner: '用人经理', status: 'pending', note: '' },
  { key: 'probation_goal', title: '岗位职责与试用期目标确认', owner: '用人经理', status: 'pending', note: '' }
]

// 主流程注入：Offer「确认入职」执行器（与 /api/offers/:id 的 joined 流转共用同一状态机）
let core = null
export function bindOnboardingCore(c) { core = c }

function notifyRole(role, type, title, body, appId = 0) {
  db.prepare(`INSERT INTO notifications(recipient_role,type,title,body,application_id,is_read,created_at)
              VALUES(?,?,?,?,?,0,?)`).run(role, type, title, body, num(appId), ts())
}

function addEvent(onboardingId, { phase = '', action, party = 'system', actor = null, note = '', detail = {} }) {
  db.prepare(`INSERT INTO onboarding_events(onboarding_id,phase,action,party,actor_id,actor_name,actor_role,note,detail,created_at)
              VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(num(onboardingId), phase, action, party, actor?.id || '', actor?.name || '', actor?.role || '',
      note, JSON.stringify(detail || {}), ts())
}

function getOnboarding(id) {
  return db.prepare('SELECT * FROM onboardings WHERE id=?').get(num(id)) || null
}
function activeOnboardingOfApp(appId) {
  return db.prepare(`SELECT * FROM onboardings WHERE application_id=? AND phase IN (${ACTIVE_PHASES.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`)
    .get(num(appId), ...ACTIVE_PHASES) || null
}
function assertVersion(row, expected) {
  if (expected !== undefined && expected !== null && expected !== '' && num(expected) !== num(row.version)) {
    conflict('交接单状态已被其他操作更新，请刷新后重试', 'version_conflict')
  }
}
function touch(id) { db.prepare('UPDATE onboardings SET updated_at=?, version=version+1 WHERE id=?').run(ts(), num(id)) }

function dateRe(v, field = '日期') {
  const s = String(v || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(new Date(s + 'T00:00:00').getTime())) {
    badRequest(`请填写正确的${field}（YYYY-MM-DD）`, 'date_invalid')
  }
  return s
}
function addMonths(dateStr, months) {
  const d = new Date(dateStr + 'T00:00:00')
  d.setMonth(d.getMonth() + months)
  return d.toISOString().slice(0, 10)
}

// 资料确认快照：以候选人档案 + Offer 信息为初始值，附加材料清单与候选人确认位
function buildProfileSnapshot(app, { entryDate } = {}) {
  const cand = db.prepare('SELECT * FROM candidates WHERE id=?').get(app.candidate_id) || {}
  const pos = db.prepare('SELECT * FROM positions WHERE id=?').get(app.position_id) || {}
  const of = db.prepare('SELECT * FROM offers WHERE application_id=? ORDER BY id DESC LIMIT 1').get(app.id)
  return {
    name: cand.name || '', phone: cand.phone || '', edu: cand.edu || '', school: cand.school || '',
    city: cand.city || '', position: pos.name || '', dept: pos.dept || '', salary: num(of?.salary, 0),
    id_card: '', bank_card: '', emergency_contact: '', address: '',
    entry_date: entryDate, note: '',
    confirmed: 0, confirmed_at: '', confirmed_by: '',
    materials: DEFAULT_MATERIALS.map(m => ({ ...m }))
  }
}

// 提交审批前置：候选人已确认且必交材料全部收到/豁免
function validateReady(snapshot) {
  if (!snapshot.confirmed) badRequest('候选人尚未完成入职资料确认（请先与候选人逐项确认）', 'profile_not_confirmed')
  const missing = (snapshot.materials || [])
    .filter(m => m.required && !['received', 'waived'].includes(m.status))
    .map(m => m.name)
  if (missing.length) badRequest(`以下必交材料未到位：${missing.join('、')}`, 'materials_missing')
}

// ================= 发起交接 =================
router.post('/', wrap((req, res) => {
  const user = currentUser(req)
  if (user.role !== 'recruiter') forbidden('发起入职交接需「招聘负责人」身份', 'role_not_allowed')
  const b = req.body || {}
  const out = tx(() => {
    const a = db.prepare('SELECT * FROM applications WHERE id=?').get(num(b.application_id))
    if (!a) return { notFound: true }
    if (a.stage !== 'hired') conflict('仅已录用（候选人已接受 Offer）的候选人可以发起入职交接', 'not_hired')
    const of = db.prepare('SELECT * FROM offers WHERE application_id=? ORDER BY id DESC LIMIT 1').get(a.id)
    if (!of || !['accepted', 'joined'].includes(of.status)) {
      conflict('候选人接受 Offer 后才能发起入职交接', 'offer_not_accepted')
    }
    if (activeOnboardingOfApp(a.id)) conflict('该候选人已有进行中的入职交接单，请勿重复发起', 'onboarding_duplicate')

    const entryDate = dateRe(b.entry_date || ts().slice(0, 10), '约定入职日期')
    const stamp = ts()
    const cand = db.prepare('SELECT * FROM candidates WHERE id=?').get(a.candidate_id)
    const pos = db.prepare('SELECT * FROM positions WHERE id=?').get(a.position_id)
    const snapshot = buildProfileSnapshot(a, { entryDate })
    const r = db.prepare(`INSERT INTO onboardings
      (application_id,candidate_id,position_id,phase,profile_snapshot,entry_date,
       created_by,created_by_name,created_at,updated_at,version)
      VALUES(?,?,?,?,?,?,?,?,?,?,1)`)
      .run(a.id, a.candidate_id, a.position_id, 'profile', JSON.stringify(snapshot), entryDate,
        user.id, user.name, stamp, stamp)
    const id = Number(r.lastInsertRowid)
    addEvent(id, {
      phase: 'profile', action: 'create', party: 'recruiter', actor: user,
      note: b.note ? `发起入职交接，约定 ${entryDate} 报到：${b.note}` : `发起入职交接，约定 ${entryDate} 报到`,
      detail: { entry_date: entryDate, candidate: cand?.name || '', position: pos?.name || '' }
    })
    // 候选人侧通知投递给招聘负责人（由其与候选人沟通），与预约模块同一惯例
    notifyRole('recruiter', 'onb_profile_started', '新的入职交接待处理（资料确认）',
      `「${cand?.name || ''} · ${pos?.name || ''}」已发起交接，请与候选人逐项确认入职材料`, a.id)
    return { ok: true, id, phase: 'profile' }
  })
  if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found', msg: '应聘记录不存在' })
  res.json(out)
}))

// ================= 资料确认阶段：更新资料/材料 =================
// body: { entry_date?, profile:{...字段}, materials:[{key,status,note}] }
router.put('/:id/profile', wrap((req, res) => {
  const user = currentUser(req)
  if (user.role !== 'recruiter') forbidden('入职资料由「招聘负责人」维护', 'role_not_allowed')
  const id = num(req.params.id)
  const b = req.body || {}
  const out = tx(() => {
    const ob = getOnboarding(id)
    if (!ob) return { notFound: true }
    // 仅资料确认阶段（含审批被退回后回到资料确认）可编辑
    if (ob.phase !== 'profile') conflict('当前阶段不能修改入职资料', 'phase_locked')
    const snapshot = parseJSON(ob.profile_snapshot, {})
    const editable = ['phone', 'id_card', 'bank_card', 'emergency_contact', 'address', 'note']
    const changes = []
    if (b.entry_date) {
      const d = dateRe(b.entry_date, '约定入职日期')
      if (d !== ob.entry_date) { snapshot.entry_date = d; changes.push(`入职日期→${d}`) }
    }
    if (b.profile && typeof b.profile === 'object') {
      editable.forEach(k => {
        if (b.profile[k] !== undefined) {
          const v = String(b.profile[k])
          if (String(snapshot[k] ?? '') !== v) { snapshot[k] = v; changes.push(k) }
        }
      })
    }
    if (Array.isArray(b.materials)) {
      b.materials.forEach(upd => {
        const m = (snapshot.materials || []).find(x => x.key === upd.key)
        if (!m) return
        if (['pending', 'received', 'waived'].includes(upd.status) && upd.status !== m.status) {
          m.status = upd.status; changes.push(`${m.name}:${upd.status}`)
        }
        if (upd.note !== undefined) m.note = String(upd.note)
      })
    }
    db.prepare('UPDATE onboardings SET profile_snapshot=?, entry_date=?, updated_at=?, version=version+1 WHERE id=?')
      .run(JSON.stringify(snapshot), snapshot.entry_date || ob.entry_date, ts(), id)
    addEvent(id, {
      phase: 'profile', action: 'profile_update', party: 'recruiter', actor: user,
      note: changes.length ? `资料更新：${changes.join('、')}` : '更新入职资料',
      detail: { changes }
    })
    return { ok: true, version: num(ob.version) + 1 }
  })
  if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
  res.json(out)
}))

// 候选人确认资料（招聘负责人电话/线下确认后代为执行）
router.post('/:id/confirm-materials', wrap((req, res) => {
  const user = currentUser(req)
  if (user.role !== 'recruiter') forbidden('候选人确认由「招聘负责人」代为登记', 'role_not_allowed')
  const id = num(req.params.id)
  const out = tx(() => {
    const ob = getOnboarding(id)
    if (!ob) return { notFound: true }
    if (ob.phase !== 'profile') conflict('仅资料确认阶段可登记候选人确认', 'phase_locked')
    const snapshot = parseJSON(ob.profile_snapshot, {})
    if (snapshot.confirmed) return { ok: true, idempotent: true }
    const missing = (snapshot.materials || []).filter(m => m.required && m.status === 'pending').map(m => m.name)
    if (missing.length) badRequest(`仍有必交材料登记为未到位：${missing.join('、')}；已收到或可豁免后再由候选人确认`, 'materials_missing')
    const stamp = ts()
    snapshot.confirmed = 1
    snapshot.confirmed_at = stamp
    snapshot.confirmed_by = user.name
    db.prepare('UPDATE onboardings SET profile_snapshot=?, updated_at=?, version=version+1 WHERE id=?')
      .run(JSON.stringify(snapshot), ts(), id)
    addEvent(id, {
      phase: 'profile', action: 'candidate_confirm', party: 'candidate', actor: user,
      note: '候选人已确认全部入职资料与个人信息（招聘负责人代为登记）',
      detail: { confirmed_at: stamp }
    })
    return { ok: true }
  })
  if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
  res.json(out)
}))

// ================= 提交审批 / 审批决定 / 退回重提 =================
function doSubmit(ob, user, { resubmit = false } = {}) {
  const snapshot = parseJSON(ob.profile_snapshot, {})
  validateReady(snapshot)
  db.prepare(`UPDATE onboardings SET phase='approval', approval_status='pending',
              submitted_by=?, submitted_by_name=?, submitted_at=?, decided_at='', decided_by='', decided_by_name='', decide_note='',
              updated_at=?, version=version+1 WHERE id=?`)
    .run(user.id, user.name, ts(), ts(), ob.id)
  addEvent(ob.id, {
    phase: 'approval', action: resubmit ? 'resubmit' : 'submit', party: 'recruiter', actor: user,
    note: resubmit ? '资料修改后重新提交用人经理审批' : '资料确认完成，提交用人经理审批',
    detail: { entry_date: ob.entry_date }
  })
  const a = db.prepare('SELECT candidate_id, position_id FROM applications WHERE id=?').get(ob.application_id)
  const cand = a && db.prepare('SELECT name FROM candidates WHERE id=?').get(a.candidate_id)
  const pos = a && db.prepare('SELECT name FROM positions WHERE id=?').get(a.position_id)
  notifyRole('hiring_manager', resubmit ? 'onb_resubmitted' : 'onb_submitted',
    resubmit ? '入职审批已修改重提，待您审批' : '新的入职交接审批待处理',
    `「${cand?.name || ''} · ${pos?.name || ''}」入职材料已确认，约定 ${ob.entry_date} 报到，请审批`, ob.application_id)
}

router.post('/:id/submit', wrap((req, res) => {
  const user = currentUser(req)
  if (user.role !== 'recruiter') forbidden('提交入职审批需「招聘负责人」身份', 'role_not_allowed')
  const id = num(req.params.id)
  const out = tx(() => {
    const ob = getOnboarding(id)
    if (!ob) return { notFound: true }
    if (ob.phase !== 'profile') conflict('仅资料确认阶段可以提交审批', 'phase_locked')
    if (ob.approval_status === 'returned') conflict('退回后的申请请使用「修改后重提」', 'use_resubmit')
    doSubmit(ob, user)
    return { ok: true, phase: 'approval' }
  })
  if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
  res.json(out)
}))

router.post('/:id/resubmit', wrap((req, res) => {
  const user = currentUser(req)
  if (user.role !== 'recruiter') forbidden('仅招聘负责人可以重新提交', 'role_not_allowed')
  const id = num(req.params.id)
  const out = tx(() => {
    const ob = getOnboarding(id)
    if (!ob) return { notFound: true }
    if (ob.phase !== 'profile' || ob.approval_status !== 'returned') conflict('仅审批被退回、处于资料确认阶段的交接单可以重提', 'not_returned')
    doSubmit(ob, user, { resubmit: true })
    return { ok: true, phase: 'approval' }
  })
  if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
  res.json(out)
}))

// 用人经理审批：approve 通过进入报到阶段；return 退回（必填意见）并回到资料确认
router.post('/:id/decide', wrap((req, res) => {
  const user = currentUser(req)
  if (user.role !== 'hiring_manager') forbidden('入职审批由「用人经理」处理', 'role_not_allowed')
  const id = num(req.params.id)
  const b = req.body || {}
  const out = tx(() => {
    const ob = getOnboarding(id)
    if (!ob) return { notFound: true }
    assertVersion(ob, b.version)
    if (ob.phase !== 'approval' || ob.approval_status !== 'pending') conflict('该交接单当前不在待审批状态', 'not_pending')

    const note = String(b.note || '')
    const a = db.prepare('SELECT candidate_id, position_id FROM applications WHERE id=?').get(ob.application_id)
    const cand = a && db.prepare('SELECT name FROM candidates WHERE id=?').get(a.candidate_id)
    const pos = a && db.prepare('SELECT name FROM positions WHERE id=?').get(a.position_id)
    const who = `「${cand?.name || ''} · ${pos?.name || ''}」`

    if (b.action === 'return') {
      if (!note.trim()) badRequest('退回必须填写退回意见', 'note_required')
      db.prepare(`UPDATE onboardings SET phase='profile', approval_status='returned',
                  decided_by=?, decided_by_name=?, decided_at=?, decide_note=?, updated_at=?, version=version+1 WHERE id=?`)
        .run(user.id, user.name, ts(), note, ts(), id)
      addEvent(id, {
        phase: 'profile', action: 'return', party: 'hiring_manager', actor: user, note,
        detail: { back_to: 'profile' }
      })
      notifyRole('recruiter', 'onb_returned', '入职审批被退回，请补充资料后重提',
        `${who}入职审批被 ${user.name} 退回：${note}`, ob.application_id)
      return { ok: true, phase: 'profile', approval_status: 'returned' }
    }
    if (b.action !== 'approve') badRequest('未知审批动作', 'unknown_action')

    db.prepare(`UPDATE onboardings SET phase='checkin', approval_status='approved',
                decided_by=?, decided_by_name=?, decided_at=?, decide_note=?, updated_at=?, version=version+1 WHERE id=?`)
      .run(user.id, user.name, ts(), note, ts(), id)
    addEvent(id, {
      phase: 'checkin', action: 'approve', party: 'hiring_manager', actor: user,
      note: note ? `审批通过：${note}` : '入职审批通过，等待候选人报到',
      detail: { entry_date: ob.entry_date }
    })
    notifyRole('recruiter', 'onb_approved', '入职审批已通过，等待候选人报到',
      `${who}入职审批已通过（${user.name}），约定 ${ob.entry_date} 报到，请安排接待`, ob.application_id)
    return { ok: true, phase: 'checkin' }
  })
  if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
  res.json(out)
}))

// ================= 报到阶段：确认报到 / 登记未报到 =================
// 确认报到：同一事务调用主流程 Offer「确认入职」回写已录用流程（offer accepted→joined + 留痕），
// 随后进入试用交接并初始化交接清单；业务状态漂移（Offer 被撤回）时整个事务回滚
router.post('/:id/checkin', wrap((req, res) => {
  const user = currentUser(req)
  if (user.role !== 'recruiter') forbidden('报到登记由「招聘负责人」处理', 'role_not_allowed')
  const id = num(req.params.id)
  const b = req.body || {}
  const out = tx(() => {
    const ob = getOnboarding(id)
    if (!ob) return { notFound: true }
    assertVersion(ob, b.version)
    if (ob.phase !== 'checkin') conflict('仅审批通过、待报到阶段可以确认报到', 'phase_locked')
    const a = db.prepare('SELECT * FROM applications WHERE id=?').get(ob.application_id)
    if (!a) badRequest('关联应聘记录不存在', 'app_missing')

    // 回写已录用流程：与 Offer 页「确认入职」完全相同的业务函数
    const r = core?.markOfferJoined
      ? core.markOfferJoined(a, { operator: user.name, note: `入职交接 #${ob.id} 报到确认` })
      : badRequest('入职交接服务未就绪', 'core_not_bound')

    const stamp = ts()
    const checkinAt = b.checkin_at ? dateRe(b.checkin_at, '实际报到日期') : stamp.slice(0, 10)
    const probationEnd = b.probation_end ? dateRe(b.probation_end, '试用截止日期') : addMonths(ob.entry_date || checkinAt, 3)
    const items = DEFAULT_HANDOVER.map(x => ({ ...x }))
    db.prepare(`UPDATE onboardings SET phase='handover', checkin_at=?, checkin_by=?, checkin_by_name=?,
                checkin_note=?, handover_items=?, probation_end=?, updated_at=?, version=version+1 WHERE id=?`)
      .run(checkinAt, user.id, user.name, String(b.note || ''), JSON.stringify(items), probationEnd, stamp, id)
    addEvent(id, {
      phase: 'handover', action: 'checkin', party: 'recruiter', actor: user,
      note: `候选人已于 ${checkinAt} 报到；Offer 回写为已入职，试用期至 ${probationEnd}`,
      detail: { checkin_at: checkinAt, probation_end: probationEnd, offer_idempotent: !!r?.idempotent }
    })
    auditPassive({
      category: 'action', action: 'onboarding.checkin', actor: user, applicationId: a.id,
      refType: 'onboarding', refId: id,
      summary: `入职交接 #${id} 候选人报到，Offer 回写为已入职，进入试用交接`,
      detail: { checkin_at: checkinAt, probation_end: probationEnd }
    })
    const cand = db.prepare('SELECT name FROM candidates WHERE id=?').get(ob.candidate_id)
    notifyRole('hiring_manager', 'onb_checkin', '候选人已报到，请安排试用交接',
      `「${cand?.name || ''}」已于 ${checkinAt} 报到，导师/账号/设备/培训等待交接登记`, a.id)
    return { ok: true, phase: 'handover', probation_end: probationEnd }
  })
  if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
  res.json(out)
}))

// 登记未报到：中止交接（必填原因）；Offer 状态不自动改写，提示招聘负责人另行处理撤回
router.post('/:id/no-show', wrap((req, res) => {
  const user = currentUser(req)
  if (user.role !== 'recruiter') forbidden('未报到登记由「招聘负责人」处理', 'role_not_allowed')
  const id = num(req.params.id)
  const b = req.body || {}
  const reason = String(b.reason || '')
  const out = tx(() => {
    const ob = getOnboarding(id)
    if (!ob) return { notFound: true }
    assertVersion(ob, b.version)
    if (ob.phase !== 'checkin') conflict('仅待报到阶段可以登记未报到', 'phase_locked')
    if (!reason.trim()) badRequest('登记未报到必须填写原因', 'reason_required')
    const stamp = ts()
    db.prepare(`UPDATE onboardings SET phase='cancelled', cancel_kind='cancel', noshow_reason=?,
                cancel_reason=?, cancelled_at=?, cancelled_by=?, cancelled_by_name=?, updated_at=?, version=version+1 WHERE id=?`)
      .run(reason, `候选人未报到：${reason}`, stamp, user.id, user.name, stamp, id)
    addEvent(id, {
      phase: 'cancelled', action: 'no_show', party: 'recruiter', actor: user,
      note: `候选人未按约定（${ob.entry_date}）报到：${reason}；Offer 未自动撤回，请在 Offer 管理中另行处理`,
      detail: { reason, entry_date: ob.entry_date }
    })
    auditPassive({
      category: 'action', action: 'onboarding.no_show', actor: user, applicationId: ob.application_id,
      refType: 'onboarding', refId: id,
      summary: `入职交接 #${id} 候选人未报到，交接中止（Offer 保留，待 HR 处理）`,
      detail: { reason, entry_date: ob.entry_date }
    })
    const cand = db.prepare('SELECT name FROM candidates WHERE id=?').get(ob.candidate_id)
    notifyRole('hiring_manager', 'onb_noshow', '候选人未报到，入职交接已中止',
      `「${cand?.name || ''}」未在 ${ob.entry_date} 报到：${reason}`, ob.application_id)
    return { ok: true, phase: 'cancelled', offer_status: 'unchanged' }
  })
  if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
  res.json(out)
}))

// ================= 试用交接：事项更新 / 完成 =================
// 用人经理主责，招聘负责人可协同登记账号/培训等 HR 事项
router.put('/:id/handover', wrap((req, res) => {
  const user = currentUser(req)
  if (!['hiring_manager', 'recruiter'].includes(user.role)) forbidden('仅用人经理/招聘负责人可登记交接事项', 'role_not_allowed')
  const id = num(req.params.id)
  const b = req.body || {}
  const out = tx(() => {
    const ob = getOnboarding(id)
    if (!ob) return { notFound: true }
    if (ob.phase !== 'handover') conflict('仅试用交接阶段可以更新交接事项', 'phase_locked')
    const items = parseJSON(ob.handover_items, [])
    const changes = []
    if (Array.isArray(b.items)) {
      b.items.forEach(upd => {
        const it = items.find(x => x.key === upd.key)
        if (!it) return
        if (['pending', 'done'].includes(upd.status) && upd.status !== it.status) {
          it.status = upd.status; changes.push(`${it.title}:${upd.status === 'done' ? '完成' : '待办'}`)
        }
        if (upd.note !== undefined) it.note = String(upd.note)
        if (upd.owner !== undefined) it.owner = String(upd.owner)
      })
    }
    let probationEnd = ob.probation_end
    if (b.probation_end) probationEnd = dateRe(b.probation_end, '试用截止日期')
    db.prepare('UPDATE onboardings SET handover_items=?, probation_end=?, updated_at=?, version=version+1 WHERE id=?')
      .run(JSON.stringify(items), probationEnd, ts(), id)
    addEvent(id, {
      phase: 'handover', action: 'handover_update',
      party: user.role === 'hiring_manager' ? 'hiring_manager' : 'recruiter', actor: user,
      note: changes.length ? `交接事项更新：${changes.join('、')}` : '更新交接事项',
      detail: { changes, probation_end: probationEnd }
    })
    return { ok: true, version: num(ob.version) + 1 }
  })
  if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
  res.json(out)
}))

// 完成试用交接：所有事项必须已完成
router.post('/:id/complete', wrap((req, res) => {
  const user = currentUser(req)
  if (user.role !== 'hiring_manager') forbidden('试用交接由「用人经理」确认完成', 'role_not_allowed')
  const id = num(req.params.id)
  const b = req.body || {}
  const out = tx(() => {
    const ob = getOnboarding(id)
    if (!ob) return { notFound: true }
    assertVersion(ob, b.version)
    if (ob.phase !== 'handover') conflict('仅试用交接阶段可以完成交接', 'phase_locked')
    const items = parseJSON(ob.handover_items, [])
    const undone = items.filter(it => it.status !== 'done').map(it => it.title)
    if (undone.length) badRequest(`以下交接事项尚未完成：${undone.join('、')}`, 'handover_items_pending')
    const stamp = ts()
    const note = String(b.note || '')
    db.prepare(`UPDATE onboardings SET phase='done', completed_at=?, completed_by=?, completed_by_name=?,
                completion_note=?, updated_at=?, version=version+1 WHERE id=?`)
      .run(stamp, user.id, user.name, note, stamp, id)
    addEvent(id, {
      phase: 'done', action: 'complete', party: 'hiring_manager', actor: user,
      note: note ? `试用交接完成：${note}` : '全部交接事项完成，入职交接闭环',
      detail: { probation_end: ob.probation_end }
    })
    auditPassive({
      category: 'action', action: 'onboarding.complete', actor: user, applicationId: ob.application_id,
      refType: 'onboarding', refId: id,
      summary: `入职交接 #${id} 试用交接完成，全流程闭环`,
      detail: { probation_end: ob.probation_end, note }
    })
    const cand = db.prepare('SELECT name FROM candidates WHERE id=?').get(ob.candidate_id)
    notifyRole('recruiter', 'onb_completed', '入职交接已完成 🎉',
      `「${cand?.name || ''}」导师/账号/设备/培训等交接事项全部完成，试用期至 ${ob.probation_end}`, ob.application_id)
    return { ok: true, phase: 'done' }
  })
  if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
  res.json(out)
}))

// ================= 撤销交接（招聘负责人；进行中各阶段均可） =================
router.post('/:id/cancel', wrap((req, res) => {
  const user = currentUser(req)
  if (user.role !== 'recruiter') forbidden('撤销交接需「招聘负责人」身份', 'role_not_allowed')
  const id = num(req.params.id)
  const b = req.body || {}
  const reason = String(b.reason || '')
  const out = tx(() => {
    const ob = getOnboarding(id)
    if (!ob) return { notFound: true }
    if (!ACTIVE_PHASES.includes(ob.phase)) conflict('该交接单已结案，无法撤销', 'phase_closed')
    if (!reason.trim()) badRequest('撤销交接必须填写原因', 'reason_required')
    const stamp = ts()
    db.prepare(`UPDATE onboardings SET phase='cancelled', cancel_kind='cancel', cancel_reason=?,
                cancelled_at=?, cancelled_by=?, cancelled_by_name=?, updated_at=?, version=version+1 WHERE id=?`)
      .run(reason, stamp, user.id, user.name, stamp, id)
    addEvent(id, {
      phase: 'cancelled', action: 'cancel', party: 'recruiter', actor: user,
      note: `撤销入职交接：${reason}`, detail: { from_phase: ob.phase, reason }
    })
    auditPassive({
      category: 'action', action: 'onboarding.cancel', actor: user, applicationId: ob.application_id,
      refType: 'onboarding', refId: id,
      summary: `入职交接 #${id} 由招聘负责人撤销（原阶段：${PHASE_LABEL[ob.phase] || ob.phase}）`,
      detail: { from_phase: ob.phase, reason }
    })
    const cand = db.prepare('SELECT name FROM candidates WHERE id=?').get(ob.candidate_id)
    notifyRole('hiring_manager', 'onb_cancelled', '入职交接已撤销',
      `「${cand?.name || ''}」的入职交接被 ${user.name} 撤销：${reason}`, ob.application_id)
    return { ok: true, phase: 'cancelled' }
  })
  if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
  res.json(out)
}))

// ---------------- 主流程被动钩子：已录用流程回退时中止进行中的交接单 ----------------
// 由 Offer 撤回（accepted→withdrawn）/ 录用异常回退在主流程事务内调用；
// 与危机审计钩子同一模式：上链/通知与业务要么同时成功要么一起回滚。
export function cancelOnboardingForApp(applicationId, { reason = '已录用流程回退（Offer 撤回）', actor = null } = {}) {
  const appId = num(applicationId)
  const ob = db.prepare(`SELECT * FROM onboardings WHERE application_id=? AND phase IN (${ACTIVE_PHASES.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`)
    .get(appId, ...ACTIVE_PHASES)
  if (!ob) return null
  const stamp = ts()
  db.prepare(`UPDATE onboardings SET phase='cancelled', cancel_kind='system', cancel_reason=?,
              cancelled_at=?, cancelled_by=?, cancelled_by_name=?, updated_at=?, version=version+1 WHERE id=?`)
    .run(reason, stamp, actor?.id || 'system', actor?.name || '系统', stamp, ob.id)
  addEvent(ob.id, {
    phase: 'cancelled', action: 'system_cancel', party: 'system', actor: actor || { id: 'system', name: '系统' },
    note: reason,
    detail: { from_phase: ob.phase, reason }
  })
  auditPassive({
    category: 'rollback', action: 'onboarding.system_cancel', actor: actor || { id: 'system', name: '系统' },
    applicationId: appId, refType: 'onboarding', refId: ob.id,
    summary: `入职交接 #${ob.id} 随已录用流程回退自动中止（原阶段：${PHASE_LABEL[ob.phase] || ob.phase}）`,
    detail: { from_phase: ob.phase, reason }
  })
  notifyRole('recruiter', 'onb_cancelled', '入职交接已随流程回退自动中止',
    `交接单 #${ob.id}：${reason}`, appId)
  notifyRole('hiring_manager', 'onb_cancelled', '入职交接已随流程回退自动中止',
    `交接单 #${ob.id}：${reason}`, appId)
  return ob
}

// ---------------- 历史数据兼容：已入职（offer joined）但无交接单的记录补录为「交接完成」 ----------------
function backfillOnboardings() {
  const hiredApps = db.prepare("SELECT * FROM applications WHERE stage='hired'").all()
  const need = hiredApps.filter(a => {
    const has = db.prepare('SELECT COUNT(*) c FROM onboardings WHERE application_id=?').get(a.id).c
    if (has) return false
    const of = db.prepare('SELECT * FROM offers WHERE application_id=? ORDER BY id DESC LIMIT 1').get(a.id)
    return of && of.status === 'joined'
  })
  if (!need.length) return
  tx(() => {
    need.forEach(a => {
      const of = db.prepare('SELECT * FROM offers WHERE application_id=? ORDER BY id DESC LIMIT 1').get(a.id)
      const cand = db.prepare('SELECT * FROM candidates WHERE id=?').get(a.candidate_id) || {}
      const pos = db.prepare('SELECT * FROM positions WHERE id=?').get(a.position_id) || {}
      const stamp = of.joined_at && /^\d{4}/.test(of.joined_at) ? of.joined_at : ts()
      const snapshot = {
        name: cand.name || '', phone: cand.phone || '', edu: cand.edu || '', school: cand.school || '',
        position: pos.name || '', dept: pos.dept || '', salary: num(of.salary, 0),
        entry_date: stamp.slice(0, 10), materials: [], confirmed: 1, backfill_note: '历史已入职数据补录，资料明细未迁移'
      }
      const r = db.prepare(`INSERT INTO onboardings
        (application_id,candidate_id,position_id,phase,approval_status,profile_snapshot,entry_date,
         submitted_at,decided_at,decided_by_name,checkin_at,checkin_by_name,handover_items,probation_end,
         completed_at,completed_by_name,backfilled,created_by_name,created_at,updated_at,version)
        VALUES(?,?,?,?,?, ?,?,?,?, ?, ?,?,?,?, ?,?, 1,?,?,?,1)`)
        .run(
          a.id, a.candidate_id, a.position_id, 'done', 'approved',
          JSON.stringify(snapshot), stamp.slice(0, 10),
          stamp, stamp, '历史补录',
          stamp, 'HR-Sandy', '[]', stamp.slice(0, 10),
          stamp, '历史补录',
          '系统迁移', stamp, stamp
        )
      const id = Number(r.lastInsertRowid)
      addEvent(id, {
        phase: 'done', action: 'migrate', party: 'system', actor: { id: 'system', name: '系统迁移' },
        note: '该候选人在功能上线前已确认入职，按历史数据补录为「交接完成」，四阶段明细不再追溯',
        detail: { joined_at: of.joined_at, salary: num(of.salary, 0) }
      })
    })
  })
  console.log(`[HR] backfilled onboarding records for ${need.length} joined hires`)
}
backfillOnboardings()

// ---------------- 状态聚合（供 /api/state 合并返回） ----------------
function appContext(ob) {
  const a = db.prepare(`SELECT ap.*, c.name candidate_name, p.name position_name, p.dept position_dept, p.city position_city
                        FROM applications ap
                        JOIN candidates c ON c.id=ap.candidate_id
                        JOIN positions p ON p.id=ap.position_id
                        WHERE ap.id=?`).get(ob.application_id)
  const of = db.prepare('SELECT * FROM offers WHERE application_id=? ORDER BY id DESC LIMIT 1').get(ob.application_id)
  return { a, of }
}

export function getOnboardingState() {
  const eventsAll = db.prepare('SELECT * FROM onboarding_events ORDER BY id ASC').all()
    .map(e => ({ ...e, detail: parseJSON(e.detail, {}), action_label: ACTION_LABEL[e.action] || e.action, party_label: PARTY_LABEL[e.party] || e.party }))
  const onboardings = db.prepare('SELECT * FROM onboardings ORDER BY id DESC').all().map(ob => {
    const { a, of } = appContext(ob)
    const snapshot = parseJSON(ob.profile_snapshot, {})
    const items = parseJSON(ob.handover_items, [])
    return {
      ...ob,
      version: num(ob.version),
      backfilled: !!ob.backfilled,
      candidate: a?.candidate_name || snapshot.name || '',
      position: a?.position_name || snapshot.position || '',
      dept: a?.position_dept || snapshot.dept || '',
      city: a?.position_city || '',
      app_stage: a?.stage || '',
      offer_id: num(of?.id || 0),
      offer_status: of?.status || '',
      salary: num(of?.salary || snapshot.salary || 0),
      phase_label: PHASE_LABEL[ob.phase] || ob.phase,
      approval_status_label: { pending: '待审批', returned: '已退回', approved: '已通过' }[ob.approval_status] || '',
      profile: snapshot,
      materials: snapshot.materials || [],
      materialsReady: (snapshot.materials || []).filter(m => m.required).every(m => ['received', 'waived'].includes(m.status)),
      handoverItems: items,
      handoverDone: items.length > 0 && items.every(i => i.status === 'done'),
      events: eventsAll.filter(e => e.onboarding_id === ob.id)
    }
  })
  return {
    onboardings,
    onboardingMeta: {
      phases: PHASES.map(k => ({ k, label: PHASE_LABEL[k] })),
      actionLabels: ACTION_LABEL, partyLabels: PARTY_LABEL,
      defaultMaterials: DEFAULT_MATERIALS, defaultHandover: DEFAULT_HANDOVER
    }
  }
}
