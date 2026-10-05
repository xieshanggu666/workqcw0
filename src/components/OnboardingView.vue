<script setup>
import { computed, ref, reactive } from 'vue'
import { useHrStore } from '@/store/hr'

const store = useHrStore()

const PHASES = [
  { k: 'profile', label: '资料确认', icon: '📋' },
  { k: 'approval', label: '审批', icon: '✅' },
  { k: 'checkin', label: '报到', icon: '🏢' },
  { k: 'handover', label: '试用交接', icon: '🧑‍🏫' }
]
const PHASE_META = {
  profile: ['📋', '资料确认', 'var(--accent)'],
  approval: ['✅', '审批中', 'var(--accent2)'],
  checkin: ['🏢', '待报到', 'var(--purple)'],
  handover: ['🧑‍🏫', '试用交接', '#4fc3f7'],
  done: ['🎉', '交接完成', 'var(--green)'],
  cancelled: ['🚫', '已中止', 'var(--muted)']
}
const MAT_STATUS = { pending: ['待提交', 'var(--muted)'], received: ['已收到', 'var(--green)'], waived: ['已豁免', 'var(--accent2)'] }

const tab = ref('active')
const detailId = ref(null)
const startAppId = ref(null)
const startDate = ref('')
const returnId = ref(null)
const returnNote = ref('')
const noShowId = ref(null)
const noShowReason = ref('')
const cancelId = ref(null)
const cancelReason = ref('')
const checkinDate = ref('')
const probationEnd = ref('')
const checkinNote = ref('')
const completeNote = ref('')
const profileForm = reactive({ phone: '', id_card: '', bank_card: '', emergency_contact: '', address: '', note: '', entry_date: '' })
const profileSavedAt = ref(0)

const isRecruiter = computed(() => store.myRole === 'recruiter')
const isHM = computed(() => store.myRole === 'hiring_manager')

const activeList = computed(() => store.onboardings.filter(ob => ['profile', 'approval', 'checkin', 'handover'].includes(ob.phase)))
const doneList = computed(() => store.onboardings.filter(ob => ['done', 'cancelled'].includes(ob.phase)))
const list = computed(() => tab.value === 'active' ? activeList.value : doneList.value)

const detail = computed(() => store.onboardings.find(o => o.id === detailId.value) || null)

// 可发起交接：已录用（Offer 已接受/已入职）且无进行中交接单
const startable = computed(() => store.applications.filter(a =>
  a.stage === 'hired' &&
  (a.offer?.status === 'accepted' || (a.offer?.status === 'joined' && !hasDoneOnboarding(a.id))) &&
  !store.activeOnboardingOf(a.id)))
function hasDoneOnboarding(appId) {
  return store.onboardings.some(o => o.application_id === appId && o.phase === 'done')
}

function phaseIndex(phase) {
  const i = PHASES.findIndex(p => p.k === phase)
  return i < 0 ? -1 : i
}

function fmtDate(d) { return d || '' }
const busy = key => !!store.pending[key]

// ---------------- 发起交接 ----------------
function openStart(a) {
  if (!isRecruiter.value) { store.notify('error', '发起入职交接需「招聘负责人」身份'); return }
  startAppId.value = a.id
  const today = new Date()
  startDate.value = today.toISOString().slice(0, 10)
}
function confirmStart() {
  if (!startDate.value) { store.notify('error', '请选择约定入职日期'); return }
  store.startOnboarding(startAppId.value, startDate.value)
  startAppId.value = null
}

// ---------------- 详情 / 资料确认 ----------------
function openDetail(ob) {
  detailId.value = ob.id
  syncProfileForm(ob)
}
function syncProfileForm(ob) {
  const p = ob.profile || {}
  profileForm.phone = p.phone || ''
  profileForm.id_card = p.id_card || ''
  profileForm.bank_card = p.bank_card || ''
  profileForm.emergency_contact = p.emergency_contact || ''
  profileForm.address = p.address || ''
  profileForm.note = p.note || ''
  profileForm.entry_date = ob.entry_date || ''
}

function setMaterial(m, status) {
  const ob = detail.value
  if (!ob || ob.phase !== 'profile' || !isRecruiter.value) return
  store.updateOnboardingProfile(ob.id, { materials: [{ key: m.key, status, note: m.note || '' }] })
}
function saveProfile() {
  const ob = detail.value
  if (!ob || !isRecruiter.value) return
  store.updateOnboardingProfile(ob.id, { entry_date: profileForm.entry_date, profile: { ...profileForm } })
  profileSavedAt.value = Date.now()
}
function onCandidateConfirm() {
  const ob = detail.value
  if (!isRecruiter.value) return
  store.confirmOnboardingMaterials(ob.id)
}
function onSubmit() {
  const ob = detail.value
  if (!isRecruiter.value) return
  if (!ob.materialsReady) { store.notify('error', '必交材料需全部收到或豁免后才能提交'); return }
  store.submitOnboarding(ob.id)
}
function onResubmit() {
  const ob = detail.value
  store.resubmitOnboarding(ob.id)
}

// ---------------- 审批 ----------------
function openReturn(ob) { returnId.value = ob.id; returnNote.value = '' }
function confirmReturn() {
  if (!returnNote.value.trim()) { store.notify('error', '退回必须填写意见'); return }
  store.decideOnboarding(returnId.value, { action: 'return', note: returnNote.value, version: detail.value.version })
  returnId.value = null
}
function onApprove(ob) {
  store.decideOnboarding(ob.id, { action: 'approve', version: ob.version })
}

// ---------------- 报到 ----------------
function openCheckin(ob) {
  checkinDate.value = ob.entry_date || new Date().toISOString().slice(0, 10)
  probationEnd.value = ob.probation_end || (() => {
    const d = new Date((ob.entry_date || checkinDate.value) + 'T00:00:00'); d.setMonth(d.getMonth() + 3)
    return d.toISOString().slice(0, 10)
  })()
  checkinNote.value = ''
}
function confirmCheckin() {
  const ob = detail.value
  if (!checkinDate.value) { store.notify('error', '请选择实际报到日期'); return }
  if (!probationEnd.value) { store.notify('error', '请选择试用截止日期'); return }
  store.checkinOnboarding(ob.id, { version: ob.version, checkin_at: checkinDate.value, probation_end: probationEnd.value, note: checkinNote.value })
}
function openNoShow(ob) { noShowId.value = ob.id; noShowReason.value = '' }
function confirmNoShow() {
  if (!noShowReason.value.trim()) { store.notify('error', '请填写未报到原因'); return }
  store.noShowOnboarding(noShowId.value, noShowReason.value, detail.value.version)
  noShowId.value = null
}

// ---------------- 试用交接 ----------------
function toggleItem(it) {
  const ob = detail.value
  if (!isHM.value && !isRecruiter.value) return
  if (ob.phase !== 'handover') return
  store.updateHandover(ob.id, { items: [{ key: it.key, status: it.status === 'done' ? 'pending' : 'done', note: it.note || '' }] })
}
function onComplete() {
  const ob = detail.value
  if (!isHM.value) { store.notify('error', '完成交接由「用人经理」确认'); return }
  if (!ob.handoverDone) { store.notify('error', '全部交接事项完成后才能闭环'); return }
  store.completeOnboarding(ob.id, ob.version, completeNote.value)
}

// ---------------- 撤销 ----------------
function openCancel(ob) { cancelId.value = ob.id; cancelReason.value = '' }
function confirmCancel() {
  if (!cancelReason.value.trim()) { store.notify('error', '撤销必须填写原因'); return }
  store.cancelOnboarding(cancelId.value, cancelReason.value)
  cancelId.value = null
}

function evTime(t) { return t ? String(t).replace('T', ' ').slice(0, 16) : '' }
</script>

<template>
  <div class="onb">
    <!-- 角色职责说明 -->
    <div class="role-banner card">
      <span v-if="isRecruiter">🧭 当前身份「招聘负责人」：发起交接、与候选人逐项确认入职资料、提交/重提审批、登记报到、协同账号培训等交接事项。候选人侧操作由您代为登记。</span>
      <span v-else-if="isHM">🏢 当前身份「用人经理」：审批入职交接（可退回附意见）、报到后登记带教导师/团队融入/试用目标等交接事项并确认完成。</span>
      <span v-else>💬 当前身份「面试官」不参与入职交接，请切换「招聘负责人」或「用人经理」身份处理。</span>
    </div>

    <div class="stat-row">
      <div class="card stat"><span>📋</span><b>{{ activeList.filter(o => o.phase === 'profile').length }}</b><em>资料确认中</em></div>
      <div class="card stat"><span>✅</span><b>{{ activeList.filter(o => o.phase === 'approval').length }}</b><em>审批中</em></div>
      <div class="card stat"><span>🏢</span><b>{{ activeList.filter(o => o.phase === 'checkin').length }}</b><em>待报到</em></div>
      <div class="card stat"><span>🧑‍🏫</span><b>{{ activeList.filter(o => o.phase === 'handover').length }}</b><em>试用交接中</em></div>
      <div class="card stat"><span>🎉</span><b>{{ store.onboardings.filter(o => o.phase === 'done').length }}</b><em>已完成交接</em></div>
    </div>

    <!-- 已录用待发起 -->
    <div class="card" v-if="startable.length && isRecruiter">
      <h3>🧳 已录用 · 待发起入职交接 <span class="tag">{{ startable.length }}</span></h3>
      <div class="start-list">
        <div class="start-item" v-for="a in startable" :key="a.id">
          <div class="si-main">
            <b>{{ a.candidate }}</b>
            <span class="muted">{{ a.position }} · {{ a.dept }} · {{ a.city }}</span>
            <span class="of-chip" v-if="a.offer?.status === 'joined'">Offer 已入职（历史）</span>
          </div>
          <div class="si-acts">
            <em class="muted">约定入职 {{ a.offer?.joined_at?.slice(0, 10) || '—' }}</em>
            <button class="primary sm" @click="openStart(a)">发起入职交接</button>
          </div>
        </div>
      </div>
    </div>

    <div class="tabs">
      <button :class="{ on: tab === 'active' }" @click="tab = 'active'">🔄 进行中 <em class="cnt" v-if="activeList.length">{{ activeList.length }}</em></button>
      <button :class="{ on: tab === 'done' }" @click="tab = 'done'">🗂️ 历史记录</button>
    </div>

    <!-- 交接单列表 -->
    <div class="tlist">
      <div class="tcard card" v-for="ob in list" :key="ob.id">
        <div class="t-head">
          <span class="t-name">🧳 {{ ob.candidate }}</span>
          <span class="phase-chip" :style="{ color: PHASE_META[ob.phase][2], borderColor: PHASE_META[ob.phase][2] }">
            {{ PHASE_META[ob.phase][0] }} {{ PHASE_META[ob.phase][1] }}
          </span>
          <span class="appr-chip" v-if="ob.phase === 'approval' && ob.approval_status === 'returned'">↩️ 已退回待重提</span>
          <em class="muted">#{{ ob.id }} · v{{ ob.version }}</em>
        </div>
        <div class="t-main">
          <span class="muted">{{ ob.position }} · {{ ob.dept }} · {{ ob.city }}</span>
          <span class="muted">月薪 ¥{{ ob.salary.toLocaleString() }}</span>
          <span class="muted">约定报到 {{ ob.entry_date }}</span>
          <span class="muted" v-if="ob.phase === 'handover' || ob.phase === 'done'">试用期至 {{ ob.probation_end }}</span>
          <span class="muted" v-if="ob.backfilled">· 历史补录</span>
        </div>
        <!-- 四阶段进度条 -->
        <div class="steps-bar">
          <template v-for="(p, i) in PHASES" :key="p.k">
            <div class="sb-node" :class="{
                  done: ob.phase === 'done' || (phaseIndex(ob.phase) > i),
                  current: ob.phase === p.k,
                  back: ob.phase === 'profile' && ob.approval_status === 'returned' && p.k === 'approval'
                }">
              <i>{{ ob.phase === 'done' || phaseIndex(ob.phase) > i ? '✓' : p.icon }}</i>
              <span>{{ p.label }}</span>
            </div>
            <em v-if="i < PHASES.length - 1" class="sb-line" :class="{ on: ob.phase === 'done' || phaseIndex(ob.phase) > i }">→</em>
          </template>
        </div>
        <div class="t-foot">
          <em class="muted">最近：{{ evTime(ob.events?.at(-1)?.created_at) }} · {{ ob.events?.at(-1)?.actor_name || '系统' }}</em>
          <div class="t-acts">
            <button class="ghost sm" @click="openDetail(ob)">📂 详情/办理</button>
            <button v-if="['profile','approval','checkin','handover'].includes(ob.phase) && isRecruiter"
              class="warn sm" @click="openCancel(ob)">撤销交接</button>
          </div>
        </div>
      </div>
      <div class="card empty" v-if="!list.length">{{ tab === 'active' ? '暂无进行中的入职交接。' : '暂无历史交接记录。' }}</div>
    </div>

    <!-- ================= 交接详情抽屉 ================= -->
    <div class="modal" v-if="detail" @click.self="detailId = null">
      <div class="detail-box card">
        <div class="d-head">
          <div>
            <h3>🧳 {{ detail.candidate }} · {{ detail.position }}</h3>
            <div class="muted">{{ detail.dept }} · {{ detail.city }} · ¥{{ detail.salary.toLocaleString() }}/月 · 交接单 #{{ detail.id }}（v{{ detail.version }}）</div>
          </div>
          <div class="d-head-acts">
            <span class="phase-chip big" :style="{ color: PHASE_META[detail.phase][2], borderColor: PHASE_META[detail.phase][2] }">
              {{ PHASE_META[detail.phase][0] }} {{ PHASE_META[detail.phase][1] }}
            </span>
            <button class="ghost" @click="detailId = null">关闭</button>
          </div>
        </div>

        <!-- 阶段一：资料确认 -->
        <section v-if="detail.phase === 'profile' || detail.phase === 'approval' || detail.phase === 'checkin' || detail.phase === 'handover' || detail.phase === 'done'">
          <div class="block" v-if="detail.phase === 'profile'">
            <h4>① 资料确认 <span class="muted">（招聘负责人与候选人逐项确认，候选人侧由 HR 代登记）</span></h4>
            <div class="back-tip" v-if="detail.approval_status === 'returned'">
              ↩️ 用人经理退回意见：{{ detail.decide_note }}。请补充资料后重新提交。
            </div>
            <div class="pgrid">
              <label>联系电话<input v-model="profileForm.phone" :disabled="!isRecruiter" /></label>
              <label>身份证号<input v-model="profileForm.id_card" :disabled="!isRecruiter" /></label>
              <label>银行卡号<input v-model="profileForm.bank_card" :disabled="!isRecruiter" /></label>
              <label>紧急联系人<input v-model="profileForm.emergency_contact" :disabled="!isRecruiter" /></label>
              <label>入职日期<input type="date" v-model="profileForm.entry_date" :disabled="!isRecruiter" /></label>
              <label class="span2">联系地址<input v-model="profileForm.address" :disabled="!isRecruiter" /></label>
              <label class="span2">备注<input v-model="profileForm.note" placeholder="住宿/特殊安排等（可选）" :disabled="!isRecruiter" /></label>
            </div>

            <div class="mat-table">
              <div class="mat-row mat-head"><span>材料</span><span>必交</span><span>状态</span><span>操作</span></div>
              <div class="mat-row" v-for="m in detail.materials" :key="m.key">
                <span>{{ m.name }}</span>
                <span :class="m.required ? 'req' : 'muted'">{{ m.required ? '必交' : '可选' }}</span>
                <span :style="{ color: MAT_STATUS[m.status]?.[1] }">{{ MAT_STATUS[m.status]?.[0] || m.status }}</span>
                <span class="mat-acts" v-if="isRecruiter">
                  <button class="sm" :class="{ on: m.status === 'received' }" @click="setMaterial(m, 'received')">已收到</button>
                  <button class="sm" :class="{ on: m.status === 'waived' }" @click="setMaterial(m, 'waived')">豁免</button>
                  <button class="sm" :class="{ on: m.status === 'pending' }" @click="setMaterial(m, 'pending')">重置</button>
                </span>
                <span v-else class="muted">—</span>
              </div>
            </div>

            <div class="confirm-line">
              <span :class="detail.profile.confirmed ? 'ok' : 'pending'">
                {{ detail.profile.confirmed ? `✅ 候选人已于 ${detail.profile.confirmed_at} 确认全部资料（${detail.profile.confirmed_by || 'HR'} 代登记）` : '⏳ 候选人尚未确认资料' }}
              </span>
            </div>
            <div class="block-acts">
              <button class="ghost" :disabled="!isRecruiter" @click="saveProfile">💾 保存资料</button>
              <button class="succ" :disabled="!isRecruiter || detail.profile.confirmed || !detail.materialsReady"
                :title="!detail.materialsReady ? '必交材料需全部收到/豁免' : '候选人电话确认后由 HR 代登记'"
                @click="onCandidateConfirm">📞 候选人已确认</button>
              <button v-if="detail.approval_status === 'returned'" class="primary" :disabled="!isRecruiter || !detail.profile.confirmed" @click="onResubmit">🔁 修改后重新提交</button>
              <button v-else class="primary" :disabled="!isRecruiter || !detail.profile.confirmed || !detail.materialsReady"
                :title="!detail.profile.confirmed ? '先登记候选人确认' : ''" @click="onSubmit">提交用人经理审批 →</button>
            </div>
          </div>

          <!-- 资料确认完成后（审批/报到/试用交接/完成）：只读回看候选人确认的资料与材料 -->
          <div class="block readonly" v-else>
            <h4>① 资料确认 <span class="muted">（{{ evTime(detail.profile.confirmed_at) }} 候选人已确认{{ detail.backfilled ? ' · 历史补录' : '' }}）</span></h4>
            <div class="ro-grid">
              <div><span class="muted">联系电话</span><b>{{ detail.profile.phone || '—' }}</b></div>
              <div><span class="muted">身份证号</span><b>{{ detail.profile.id_card || '—' }}</b></div>
              <div><span class="muted">银行卡号</span><b>{{ detail.profile.bank_card || '—' }}</b></div>
              <div><span class="muted">紧急联系人</span><b>{{ detail.profile.emergency_contact || '—' }}</b></div>
              <div><span class="muted">约定入职</span><b>{{ detail.entry_date }}</b></div>
              <div><span class="muted">联系地址</span><b>{{ detail.profile.address || '—' }}</b></div>
            </div>
            <div class="ro-mats">
              <span v-for="m in detail.materials" :key="m.key" class="ro-mat" :class="m.status">
                {{ MAT_STATUS[m.status]?.[0] || m.status }} · {{ m.name }}{{ !m.required ? '（可选）' : '' }}
              </span>
              <span v-if="!detail.materials.length" class="muted">历史补录记录，材料明细未迁移。</span>
            </div>
            <div class="ro-note" v-if="detail.profile.note">备注：{{ detail.profile.note }}</div>
          </div>

          <!-- 阶段二：审批 -->
          <div class="block" v-if="detail.phase === 'approval'">
            <h4>② 入职审批</h4>
            <div class="approval-chain">
              <div class="ac-node done"><i>📨</i><span>招聘负责人提交<br><em class="muted">{{ detail.submitted_by_name }} · {{ evTime(detail.submitted_at) }}</em></span></div>
              <em>→</em>
              <div class="ac-node" :class="detail.approval_status === 'pending' ? 'current' : 'done'">
                <i>{{ detail.approval_status === 'pending' ? '⏳' : '✓' }}</i>
                <span>用人经理审批<em class="muted" v-if="detail.decided_at"><br>{{ detail.decided_by_name }} · {{ evTime(detail.decided_at) }}</em></span>
              </div>
            </div>
            <div class="mat-summary">
              候选人已确认全部入职资料（{{ evTime(detail.profile.confirmed_at) }}），必交材料 {{ detail.materials.filter(m => m.required).length }} 项全部到位，约定 {{ detail.entry_date }} 报到。
            </div>
            <div class="block-acts" v-if="detail.approval_status === 'pending'">
              <template v-if="isHM">
                <button class="succ" :disabled="busy(`onb-decide:${detail.id}`)" @click="onApprove(detail)">✅ 审批通过</button>
                <button class="warn" @click="openReturn(detail)">↩️ 退回补充</button>
              </template>
              <em v-else class="muted">等待「用人经理」审批…</em>
            </div>
          </div>

          <!-- 阶段三：报到 -->
          <div class="block" v-if="detail.phase === 'checkin'">
            <h4>③ 报到登记</h4>
            <div class="check-info">审批已通过（{{ detail.decided_by_name }}），等待候选人按约定 {{ detail.entry_date }} 报到。报到确认后系统将把 Offer 回写为「已入职」并进入试用交接。</div>
            <div class="pgrid">
              <label>实际报到日期<input type="date" v-model="checkinDate" :disabled="!isRecruiter" /></label>
              <label>试用截止日期<input type="date" v-model="probationEnd" :disabled="!isRecruiter" /></label>
              <label class="span2">报到备注<input v-model="checkinNote" placeholder="工位/陪同人等（可选）" :disabled="!isRecruiter" /></label>
            </div>
            <div class="block-acts" v-if="isRecruiter">
              <button class="primary" :disabled="busy(`onb-checkin:${detail.id}`)" @click="confirmCheckin">🏢 确认报到并回写已入职</button>
              <button class="warn" @click="openNoShow(detail)">⚠️ 登记未报到</button>
            </div>
          </div>

          <!-- 阶段四：试用交接 -->
          <div class="block" v-if="detail.phase === 'handover' || detail.phase === 'done'">
            <h4>④ 试用交接 <span class="muted">（报到 {{ detail.checkin_at }} · 试用期至 {{ detail.probation_end }}）</span></h4>
            <div class="ho-list">
              <div class="ho-item" v-for="it in detail.handoverItems" :key="it.key" :class="{ done: it.status === 'done' }">
                <label class="ho-check">
                  <input type="checkbox" :checked="it.status === 'done'" :disabled="detail.phase !== 'handover' || (!isHM && !isRecruiter)" @change="toggleItem(it)">
                  <b>{{ it.title }}</b>
                </label>
                <span class="ho-owner">{{ it.owner }}</span>
                <span class="ho-state">{{ it.status === 'done' ? '✅ 已完成' : '⏳ 待办' }}</span>
              </div>
            </div>
            <div class="pgrid" v-if="detail.phase === 'handover' && isHM">
              <label class="span2">交接总结（可选）<input v-model="completeNote" placeholder="首月跟进/特殊关注事项" /></label>
            </div>
            <div class="block-acts" v-if="detail.phase === 'handover'">
              <em class="muted">待办 {{ detail.handoverItems.filter(i => i.status !== 'done').length }} 项</em>
              <button class="primary" :disabled="!isHM || !detail.handoverDone || busy(`onb-complete:${detail.id}`)"
                :title="!isHM ? '由用人经理确认完成' : !detail.handoverDone ? '全部事项完成后可闭环' : ''" @click="onComplete">🎉 完成试用交接</button>
            </div>
            <div class="done-tip" v-if="detail.phase === 'done'">
              🎉 交接已于 {{ detail.completed_at }} 完成（{{ detail.completed_by_name }} 确认）{{ detail.completion_note ? '：' + detail.completion_note : '' }}
            </div>
          </div>
        </section>

        <div class="block" v-if="detail.phase === 'cancelled'">
          <h4>🚫 交接已中止</h4>
          <div class="cancel-info">{{ detail.cancel_reason || detail.noshow_reason }}（{{ evTime(detail.cancelled_at) }}）。同一应聘可重新发起交接。</div>
        </div>

        <!-- 全流程时间线 -->
        <div class="tl-box">
          <h4>📜 交接记录（只追加）</h4>
          <div class="timeline">
            <div class="tl-item" v-for="e in detail.events" :key="e.id">
              <div class="tl-dot">{{ { create: '🧳', profile_update: '✏️', candidate_confirm: '📞', submit: '📨', resubmit: '🔁', approve: '✅', return: '↩️', checkin: '🏢', no_show: '⚠️', handover_update: '🧑‍🏫', complete: '🎉', cancel: '🚫', system_cancel: '⏸️', migrate: '🗂️' }[e.action] || '•' }}</div>
              <div class="tl-body">
                <div class="tl-head">
                  <b>{{ e.action_label }}</b>
                  <span class="tl-party">{{ e.party_label }}</span>
                  <em class="muted">{{ evTime(e.created_at) }} · {{ e.actor_name || '系统' }}</em>
                </div>
                <p v-if="e.note">{{ e.note }}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 发起交接 -->
    <div class="modal" v-if="startAppId" @click.self="startAppId = null">
      <div class="modal-box card">
        <h3>🧳 发起入职交接</h3>
        <p class="muted">候选人已接受 Offer（已录用）。交接将依次经过：资料确认 → 用人经理审批 → 报到 → 试用交接。</p>
        <label class="muted">约定入职（报到）日期</label>
        <input type="date" v-model="startDate" />
        <div class="acts">
          <button class="primary" @click="confirmStart">发起交接</button>
          <button class="ghost" @click="startAppId = null">取消</button>
        </div>
      </div>
    </div>

    <!-- 审批退回 -->
    <div class="modal" v-if="returnId" @click.self="returnId = null">
      <div class="modal-box card">
        <h3>↩️ 退回入职审批</h3>
        <textarea v-model="returnNote" rows="3" placeholder="退回意见（必填），招聘负责人补充资料后可重新提交"></textarea>
        <div class="acts">
          <button class="warn" @click="confirmReturn">确认退回</button>
          <button class="ghost" @click="returnId = null">取消</button>
        </div>
      </div>
    </div>

    <!-- 未报到 -->
    <div class="modal" v-if="noShowId" @click.self="noShowId = null">
      <div class="modal-box card">
        <h3>⚠️ 登记未报到</h3>
        <p class="muted">交接将中止；Offer 不会自动撤回，请在 Offer 管理中根据实际情况处理。</p>
        <textarea v-model="noShowReason" rows="3" placeholder="未报到原因（必填）"></textarea>
        <div class="acts">
          <button class="warn" @click="confirmNoShow">确认登记</button>
          <button class="ghost" @click="noShowId = null">取消</button>
        </div>
      </div>
    </div>

    <!-- 撤销交接 -->
    <div class="modal" v-if="cancelId" @click.self="cancelId = null">
      <div class="modal-box card">
        <h3>🚫 撤销入职交接</h3>
        <textarea v-model="cancelReason" rows="3" placeholder="撤销原因（必填）"></textarea>
        <div class="acts">
          <button class="warn" @click="confirmCancel">确认撤销</button>
          <button class="ghost" @click="cancelId = null">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.onb { display: flex; flex-direction: column; gap: 14px; }
.role-banner { padding: 10px 14px; font-size: 12.5px; color: var(--muted); background: rgba(87,214,160,.07); border-color: rgba(87,214,160,.28); }
.stat-row { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; }
.stat { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 13px; }
.stat span { font-size: 20px; }
.stat b { font-size: 22px; color: var(--green); }
.stat em { font-style: normal; font-size: 12px; color: var(--muted); }
.start-list { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
.start-item { display: flex; justify-content: space-between; align-items: center; padding: 10px 12px; background: var(--panel2); border: 1px solid var(--border); border-radius: 10px; flex-wrap: wrap; gap: 8px; }
.si-main { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.si-acts { display: flex; align-items: center; gap: 10px; }
.of-chip { font-size: 10px; color: var(--muted); border: 1px solid var(--border); border-radius: 9px; padding: 1px 7px; }
.tabs { display: flex; gap: 8px; }
.tabs button { padding: 7px 14px; font-size: 13px; opacity: .8; }
.tabs button.on { opacity: 1; border-color: var(--green); background: rgba(87,214,160,.12); color: var(--green); }
.cnt { font-style: normal; font-size: 10px; background: var(--red); color: #fff; border-radius: 8px; padding: 1px 6px; margin-left: 4px; }
.tlist { display: flex; flex-direction: column; gap: 12px; }
.tcard { padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
.t-head { display: flex; align-items: center; gap: 10px; }
.t-name { font-weight: 700; font-size: 15px; }
.t-head em { margin-left: auto; font-style: normal; font-size: 11px; }
.t-main { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12.5px; }
.phase-chip { font-size: 11px; border: 1px solid; border-radius: 10px; padding: 2px 9px; white-space: nowrap; }
.phase-chip.big { font-size: 12px; padding: 4px 11px; }
.appr-chip { font-size: 11px; color: var(--red); border: 1px solid rgba(255,107,122,.4); background: rgba(255,107,122,.08); border-radius: 10px; padding: 2px 8px; }
button.sm { font-size: 11px; padding: 4px 9px; }
.steps-bar { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.sb-node { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); padding: 4px 10px; border-radius: 14px; border: 1px solid var(--border); background: var(--panel2); }
.sb-node.done { color: var(--green); border-color: rgba(87,214,160,.4); background: rgba(87,214,160,.08); }
.sb-node.current { color: var(--accent2); border-color: rgba(255,209,102,.5); background: rgba(255,209,102,.1); box-shadow: 0 0 0 2px rgba(255,209,102,.1); }
.sb-node i { font-style: normal; }
.sb-line { color: var(--border); font-style: normal; }
.sb-line.on { color: var(--green); }
.t-foot { display: flex; justify-content: space-between; align-items: center; }
.t-acts { display: flex; gap: 8px; }
.empty { padding: 30px; text-align: center; color: var(--muted); }
.modal { position: fixed; inset: 0; background: rgba(4,8,18,.68); z-index: 50; display: flex; justify-content: flex-end; }
.detail-box { width: min(720px, 100%); height: 100%; border-radius: 0; overflow-y: auto; padding: 18px; display: flex; flex-direction: column; gap: 14px; }
.d-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.d-head-acts { display: flex; gap: 8px; align-items: center; }
.block { background: var(--panel2); border: 1px solid var(--border); border-radius: 12px; padding: 13px 15px; display: flex; flex-direction: column; gap: 11px; }
.block h4 { font-size: 14px; }
.block.readonly { background: rgba(13,18,32,.22); }
.ro-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 9px 14px; }
.ro-grid > div { display: flex; flex-direction: column; gap: 2px; font-size: 13px; }
.ro-grid span { font-size: 11px; }
.ro-mats { display: flex; flex-wrap: wrap; gap: 6px; }
.ro-mat { font-size: 11px; border: 1px solid var(--border); border-radius: 9px; padding: 2px 9px; color: var(--muted); background: rgba(13,18,32,.3); }
.ro-mat.received { color: var(--green); border-color: rgba(87,214,160,.4); }
.ro-mat.waived { color: var(--accent2); border-color: rgba(255,209,102,.4); }
.ro-note { font-size: 12px; color: var(--muted); }
.back-tip { font-size: 12px; color: var(--red); background: rgba(255,107,122,.08); border: 1px solid rgba(255,107,122,.3); border-radius: 8px; padding: 7px 10px; }
.pgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
.pgrid label { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; color: var(--muted); }
.pgrid .span2 { grid-column: span 2; }
.pgrid input { padding: 7px 9px; font-size: 13px; }
.mat-table { display: flex; flex-direction: column; gap: 2px; border: 1px solid var(--border); border-radius: 9px; overflow: hidden; }
.mat-row { display: grid; grid-template-columns: 2fr 70px 90px 1fr; align-items: center; gap: 8px; padding: 7px 11px; font-size: 12.5px; background: rgba(13,18,32,.25); }
.mat-row + .mat-row { border-top: 1px solid var(--border); }
.mat-head { font-size: 11px; color: var(--muted); background: rgba(91,140,255,.08); }
.mat-acts { display: flex; gap: 5px; }
.mat-acts button { padding: 2px 8px; font-size: 11px; opacity: .75; }
.mat-acts button.on { opacity: 1; border-color: var(--green); background: rgba(87,214,160,.15); color: var(--green); }
.req { color: var(--red); }
.confirm-line .ok { color: var(--green); font-size: 12.5px; }
.confirm-line .pending { color: var(--accent2); font-size: 12.5px; }
.block-acts { display: flex; gap: 9px; align-items: center; flex-wrap: wrap; }
.approval-chain { display: flex; align-items: center; gap: 12px; }
.ac-node { display: flex; align-items: center; gap: 8px; font-size: 13px; padding: 9px 13px; border-radius: 12px; border: 1px solid var(--border); background: rgba(13,18,32,.3); }
.ac-node.done { border-color: rgba(87,214,160,.4); color: var(--green); }
.ac-node.current { border-color: rgba(255,209,102,.5); color: var(--accent2); box-shadow: 0 0 0 2px rgba(255,209,102,.12); }
.ac-node i { font-style: normal; }
.ac-node em { font-style: normal; font-size: 11px; font-weight: 400; }
.approval-chain > em { font-style: normal; color: var(--muted); }
.mat-summary { font-size: 12.5px; color: var(--muted); background: rgba(13,18,32,.3); border-radius: 8px; padding: 9px 11px; }
.check-info { font-size: 12.5px; color: var(--muted); }
.ho-list { display: flex; flex-direction: column; gap: 7px; }
.ho-item { display: grid; grid-template-columns: 1fr 120px 80px; align-items: center; gap: 10px; padding: 8px 11px; border: 1px solid var(--border); border-radius: 9px; background: rgba(13,18,32,.25); }
.ho-item.done { border-color: rgba(87,214,160,.35); opacity: .92; }
.ho-check { display: flex; align-items: center; gap: 9px; font-size: 13px; cursor: pointer; }
.ho-item.done .ho-check b { color: var(--green); text-decoration: line-through; text-decoration-color: rgba(87,214,160,.5); }
.ho-owner { font-size: 11px; color: var(--muted); }
.ho-state { font-size: 11.5px; }
.ho-item.done .ho-state { color: var(--green); }
.done-tip { font-size: 13px; color: var(--green); background: rgba(87,214,160,.08); border: 1px solid rgba(87,214,160,.3); border-radius: 8px; padding: 9px 11px; }
.cancel-info { font-size: 12.5px; color: var(--muted); }
.tl-box { border-top: 1px dashed var(--border); padding-top: 12px; }
.tl-box h4 { font-size: 13px; margin-bottom: 10px; }
.timeline { display: flex; flex-direction: column; gap: 10px; }
.tl-item { display: flex; gap: 10px; position: relative; }
.tl-item:not(:last-child)::before { content: ''; position: absolute; left: 13px; top: 28px; bottom: -12px; width: 2px; background: var(--border); }
.tl-dot { width: 28px; height: 28px; border-radius: 50%; background: var(--panel2); border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; z-index: 1; flex-shrink: 0; font-size: 13px; }
.tl-body { flex: 1; min-width: 0; }
.tl-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12.5px; }
.tl-party { font-size: 10px; color: var(--purple); border: 1px solid rgba(167,139,250,.35); background: rgba(167,139,250,.1); border-radius: 9px; padding: 1px 7px; }
.tl-head em { margin-left: auto; font-style: normal; font-size: 11px; }
.tl-body p { font-size: 12px; color: var(--muted); margin-top: 2px; }
.modal-box { width: min(430px, 92vw); margin: auto; padding: 18px; display: flex; flex-direction: column; gap: 10px; }
.modal-box label.muted { font-size: 12px; }
.modal-box input { width: 100%; padding: 9px; }
textarea { width: 100%; background: #101731; border: 1px solid var(--border); border-radius: 8px; color: var(--text); padding: 8px; font-size: 13px; font-family: inherit; resize: vertical; }
.acts { display: flex; gap: 10px; justify-content: flex-end; margin-top: 4px; }
@media (max-width: 720px) { .stat-row { grid-template-columns: repeat(2, 1fr); } .pgrid { grid-template-columns: 1fr; } .pgrid .span2 { grid-column: span 1; } .ho-item { grid-template-columns: 1fr; } .ro-grid { grid-template-columns: 1fr; } }
</style>
