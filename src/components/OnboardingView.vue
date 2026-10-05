<script setup>
import { computed, ref } from 'vue'
import { useHrStore } from '@/store/hr'

const store = useHrStore()

const PHASES = [
  { key: 'material', label: '资料确认', icon: '📋' },
  { key: 'approval', label: '审批', icon: '✅' },
  { key: 'report', label: '报到', icon: '🏢' },
  { key: 'handover', label: '试用交接', icon: '🤝' }
]
const STATUS_STYLE = {
  material: ['📋', '资料确认', 'var(--accent)'],
  approval: ['⏳', '交接审批中', 'var(--accent2)'],
  report: ['🏢', '待报到', 'var(--purple)'],
  handover: ['🤝', '试用交接', '#4fc3f7'],
  completed: ['🎉', '交接完成', 'var(--green)'],
  cancelled: ['🚫', '已取消', 'var(--muted)']
}

// 已录用（接受 Offer）且没有有效交接的人员：招聘负责人可发起交接
const startableApps = computed(() => store.applications.filter(a =>
  a.stage === 'hired' &&
  ['accepted', 'joined'].includes(a.offer?.status) &&
  !store.activeOnboardingOf(a.id)))
const activeList = computed(() => store.onboardings.filter(o => o.active))
const finishedList = computed(() => store.onboardings.filter(o => !o.active))

const isRecruiter = computed(() => store.myRole === 'recruiter')
const isManager = computed(() => store.myRole === 'hiring_manager')
const fmt = t => t ? String(t).replace('T', ' ').slice(0, 16) : ''
const fmtDate = t => t ? String(t).replace('T', ' ').slice(0, 10) : ''

const filter = ref('active')
const list = computed(() => filter.value === 'active' ? activeList.value : finishedList.value)

// 阶段步骤条状态：completed/cancelled 四步均结束
function phaseState(o, key) {
  if (o.status === 'cancelled') return 'dead'
  const order = ['material', 'approval', 'report', 'handover']
  const cur = order.indexOf(o.status)
  const idx = order.indexOf(key)
  if (o.status === 'completed') return 'done'
  if (idx < cur) return 'done'
  if (idx === cur) return 'current'
  return 'todo'
}
const obTask = o => store.approvals.find(t => t.id === o.approval_task_id) || null

// ---- 资料确认 ----
async function toggleMaterial(o, key) {
  if (!isRecruiter.value || o.status !== 'material') return
  const item = o.material_items.find(i => i.key === key)
  await store.updateOnboardingMaterial(o.id, { version: o.version, items: { [key]: !item.confirmed } })
}
const allMaterialDone = o => o.material_total > 0 && o.material_confirmed_count === o.material_total
async function setCandidateConfirmed(o, val) {
  if (!isRecruiter.value || o.status !== 'material') return
  await store.updateOnboardingMaterial(o.id, { version: o.version, candidate_confirmed: val })
}
async function saveExpected(o, val) {
  if (!isRecruiter.value || o.status !== 'material') return
  await store.updateOnboardingMaterial(o.id, { version: o.version, expected_onboard_at: val })
}
// 提交审批（复用审批中心的申请通道：onboarding_start，用人经理审批）
function submitApproval(o) {
  store.submitApproval({ type: 'onboarding_start', application_id: o.application_id })
}

// ---- 报到 ----
async function confirmReport(o) {
  if (!isRecruiter.value) return
  // 预计报到为「日期」时补成当日 09:00，避免空时刻；留空则用服务端当前时间
  let reportAt
  if (o.expected_onboard_at && /^\d{4}-\d{2}-\d{2}$/.test(o.expected_onboard_at)) {
    reportAt = `${o.expected_onboard_at} 09:00`
  } else {
    reportAt = o.expected_onboard_at || undefined
  }
  await store.reportOnboarding(o.id, {
    version: o.version,
    report_at: reportAt,
    note: '候选人按期报到'
  })
}
const delayTarget = ref(null)
const delayDate = ref('')
const delayReason = ref('')
function openDelay(o) {
  delayTarget.value = o
  delayDate.value = fmtDate(o.expected_onboard_at)
  delayReason.value = ''
}
async function submitDelay() {
  const o = delayTarget.value
  if (!delayDate.value) { store.notify('error', '请选择新的报到日期'); return }
  if (!delayReason.value.trim()) { store.notify('error', '请填写延期原因'); return }
  const r = await store.delayOnboarding(o.id, {
    version: o.version,
    expected_onboard_at: delayDate.value,
    reason: delayReason.value
  })
  if (r) delayTarget.value = null
}

// ---- 试用交接 ----
async function toggleReady(o, key) {
  if (!isRecruiter.value || o.status !== 'handover') return
  const item = o.handover_items.find(i => i.key === key)
  await store.updateHandover(o.id, { version: o.version, key, ready: !item.ready })
}
async function toggleConfirm(o, key) {
  if (!isManager.value || o.status !== 'handover') return
  const item = o.handover_items.find(i => i.key === key)
  if (!item.ready) { store.notify('error', '该项尚未备齐，不能确认'); return }
  await store.updateHandover(o.id, { version: o.version, key, confirmed: !item.confirmed })
}
const allReady = o => o.handover_total > 0 && o.ready_count === o.handover_total
const allConfirmed = o => o.handover_total > 0 && o.confirmed_count === o.handover_total
async function complete(o) {
  if (!isManager.value) { store.notify('error', '完成交接需「用人经理」确认'); return }
  await store.completeOnboarding(o.id, o.version)
}

// ---- 发起 / 取消 ----
const startTarget = ref(null)
const startDate = ref('')
function openStart(a) {
  if (!isRecruiter.value) { store.notify('error', '发起交接需「招聘负责人」身份'); return }
  startTarget.value = a
  startDate.value = ''
}
async function submitStart() {
  const a = startTarget.value
  const r = await store.startOnboarding(a.id, startDate.value)
  if (r) startTarget.value = null
}
const cancelTarget = ref(null)
const cancelReason = ref('')
function openCancel(o) { cancelTarget.value = o; cancelReason.value = '' }
async function submitCancel() {
  const o = cancelTarget.value
  if (!cancelReason.value.trim()) { store.notify('error', '请填写取消原因'); return }
  const r = await store.cancelOnboarding(o.id, { version: o.version, reason: cancelReason.value })
  if (r) cancelTarget.value = null
}

const showLogs = ref({})
function toggleLogs(id) { showLogs.value = { ...showLogs.value, [id]: !showLogs.value[id] } }
function busy(o, key) { return !!store.pending[`${key}:${o.id}`] }
</script>

<template>
  <div class="ob">
    <!-- 流程说明 -->
    <div class="intro card">
      <span>🧳 <b>候选人入职交接</b>：候选人、招聘负责人、用人经理协同走
        <b>① 资料确认 → ② 审批 → ③ 报到 → ④ 试用交接</b> 四阶段。候选人侧操作由招聘负责人电话/短信确认后代为执行；
        交接审批复用审批链（招聘负责人发起 → 用人经理审批）；报到确认在同一事务把 Offer 回写为「已入职」；
        试用交接由招聘负责人逐项备齐、用人经理逐项确认后结案。流程回退/Offer 撤回/危机处置会同步取消在途交接并留痕。
      </span>
    </div>

    <!-- 统计 -->
    <div class="stat-row">
      <div class="card stat"><span>📋</span><b>{{ store.onboardings.filter(o => o.status === 'material').length }}</b><em>资料确认</em></div>
      <div class="card stat"><span>⏳</span><b>{{ store.onboardings.filter(o => o.status === 'approval').length }}</b><em>交接审批</em></div>
      <div class="card stat"><span>🏢</span><b>{{ store.onboardings.filter(o => o.status === 'report').length }}</b><em>待报到</em></div>
      <div class="card stat"><span>🤝</span><b>{{ store.onboardings.filter(o => o.status === 'handover').length }}</b><em>试用交接</em></div>
      <div class="card stat"><span>🎉</span><b>{{ store.onboardings.filter(o => o.status === 'completed').length }}</b><em>交接完成</em></div>
      <div class="card stat"><span>🚀</span><b>{{ startableApps.length }}</b><em>待发起交接</em></div>
    </div>

    <!-- 待发起：已录用且无有效交接 -->
    <div class="card" v-if="startableApps.length">
      <h3>🚀 待发起交接 <span class="tag">{{ startableApps.length }}</span></h3>
      <div class="start-list">
        <div class="start-item" v-for="a in startableApps" :key="a.id">
          <div class="si-main">
            <b>{{ a.candidate }}</b>
            <span class="muted">{{ a.position }} · {{ a.dept }}</span>
            <span class="of-chip" :class="a.offer?.status">Offer {{ a.offer?.status === 'joined' ? '已入职（历史确认，兼容补建交接）' : '已接受' }}</span>
          </div>
          <button class="primary" :disabled="!isRecruiter" @click="openStart(a)">发起入职交接</button>
        </div>
      </div>
    </div>

    <div class="tabs">
      <button :class="{ on: filter === 'active' }" @click="filter = 'active'">🔄 进行中（{{ activeList.length }}）</button>
      <button :class="{ on: filter === 'finished' }" @click="filter = 'finished'">🗂️ 历史记录（{{ finishedList.length }}）</button>
    </div>

    <!-- 交接单 -->
    <div class="ob-list">
      <div class="ob-card card" v-for="o in list" :key="o.id" :class="['st-' + o.status]">
        <div class="ob-head">
          <div class="ob-id">
            <b>{{ o.candidate }}</b>
            <span class="muted">{{ o.position }} · {{ o.dept }}</span>
          </div>
          <span class="ob-status" :style="{ color: STATUS_STYLE[o.status][2], borderColor: STATUS_STYLE[o.status][2] }">
            {{ STATUS_STYLE[o.status][0] }} {{ STATUS_STYLE[o.status][1] }}
          </span>
          <em class="muted ob-no">#{{ o.id }}</em>
        </div>

        <!-- 四阶段步骤条 -->
        <div class="stepper">
          <template v-for="(p, i) in PHASES" :key="p.key">
            <div class="step" :class="phaseState(o, p.key)">
              <i>{{ phaseState(o, p.key) === 'done' ? '✓' : p.icon }}</i>
              <span>{{ p.label }}</span>
            </div>
            <em class="arrow" v-if="i < PHASES.length - 1">→</em>
          </template>
        </div>

        <!-- ① 资料确认 -->
        <div class="phase" v-if="o.active && ['material', 'approval'].includes(o.status)">
          <div class="phase-title">
            <h4>📋 资料确认</h4>
            <span class="muted">候选人侧由招聘负责人电话/短信确认后代为勾选</span>
          </div>
          <div class="mat-grid">
            <label class="mat-item" v-for="it in o.material_items" :key="it.key"
                   :class="{ done: it.confirmed, locked: o.status !== 'material' || !isRecruiter }">
              <input type="checkbox" :checked="!!it.confirmed" :disabled="o.status !== 'material' || !isRecruiter"
                     @change="toggleMaterial(o, it.key)" />
              <span>{{ it.label }}</span>
              <em class="muted" v-if="it.confirmed && it.at">{{ it.by || '招聘负责人' }} · {{ fmt(it.at) }}</em>
            </label>
          </div>
          <div class="mat-foot">
            <label class="cand-confirm" :class="{ on: o.candidate_confirmed }">
              <input type="checkbox" :checked="o.candidate_confirmed"
                     :disabled="o.status !== 'material' || !isRecruiter || (!allMaterialDone(o) && !o.candidate_confirmed)"
                     @change="setCandidateConfirmed(o, $event.target.checked)" />
              <span>📞 候选人本人已确认全部资料无误</span>
            </label>
            <label class="expect-date">
              <span class="muted">预计报到</span>
              <input type="date" :value="fmtDate(o.expected_onboard_at)" :disabled="o.status !== 'material' || !isRecruiter"
                     @change="saveExpected(o, $event.target.value)" />
            </label>
          </div>
          <div class="phase-acts" v-if="o.status === 'material'">
            <span class="muted" v-if="!allMaterialDone(o)">还需确认 {{ o.material_total - o.material_confirmed_count }} 项资料</span>
            <span class="muted warn-text" v-else-if="!o.candidate_confirmed">资料已齐，请取得候选人本人确认</span>
            <button class="primary" :disabled="!isRecruiter || !allMaterialDone(o) || !o.candidate_confirmed || !!store.pendingTask(o.application_id, 'onboarding_start')"
              :title="!allMaterialDone(o) || !o.candidate_confirmed ? '资料与候选人确认齐备后可提交审批' : '提交用人经理审批'"
              @click="submitApproval(o)">
              {{ store.pendingTask(o.application_id, 'onboarding_start') ? '⏳ 审批已提交' : '提交交接审批 →' }}
            </button>
            <button class="warn sm" :disabled="!isRecruiter || busy(o, 'ob-cancel')" @click="openCancel(o)">取消交接</button>
          </div>
        </div>

        <!-- ② 审批 -->
        <div class="phase" v-else-if="o.active && o.status === 'approval'">
          <div class="approval-box">
            <div class="phase-title"><h4>⏳ 交接审批中</h4></div>
            <div class="ap-info">
              <span>审批链：招聘负责人 <b>{{ obTask(o)?.submitted_by_name || '' }}</b> 提交 → <b>用人经理</b>审批</span>
              <span class="muted">预计报到：{{ fmt(o.expected_onboard_at) || '待定' }}</span>
            </div>
            <div class="ap-route">
              <span class="node done">📨 已提交</span><em>→</em>
              <span class="node" :class="obTask(o)?.status === 'pending' ? 'current' : ''">⏳ 用人经理审批</span>
            </div>
            <div class="phase-acts">
              <button class="ghost" @click="store.goView('approval')">前往审批中心处理</button>
              <button class="warn sm" :disabled="!isRecruiter" @click="openCancel(o)">取消交接</button>
            </div>
          </div>
        </div>

        <!-- ③ 报到 -->
        <div class="phase" v-else-if="o.active && o.status === 'report'">
          <div class="phase-title">
            <h4>🏢 报到</h4>
            <span class="muted">审批已通过，招聘负责人联系候选人按期报到；确认后 Offer 同事务回写为「已入职」</span>
          </div>
          <div class="report-info">
            <span>预计报到：<b>{{ fmt(o.expected_onboard_at) || '待定' }}</b></span>
            <span class="delay-chip" v-if="o.delay_count">已延期 {{ o.delay_count }} 次</span>
            <span class="muted">Offer 当前：{{ o.offer_status === 'joined' ? '已入职（兼容幂等）' : '已接受' }}</span>
          </div>
          <div class="phase-acts">
            <button class="primary" :disabled="!isRecruiter || busy(o, 'ob-report')" @click="confirmReport">✅ 候选人已报到，确认入职</button>
            <button class="ghost" :disabled="!isRecruiter" @click="openDelay(o)">⏳ 报到延期</button>
            <button class="warn sm" :disabled="!isRecruiter" @click="openCancel(o)">取消交接</button>
          </div>
        </div>

        <!-- ④ 试用交接 -->
        <div class="phase" v-else-if="o.status === 'handover' || o.status === 'completed'">
          <div class="phase-title">
            <h4>🤝 试用交接</h4>
            <span class="muted">招聘负责人逐项<b>备齐</b>，用人经理逐项<b>确认</b>；全部确认后由用人经理完成交接</span>
          </div>
          <div class="hd-list">
            <div class="hd-item" v-for="it in o.handover_items" :key="it.key" :class="{ ready: it.ready, confirmed: it.confirmed }">
              <div class="hd-main">
                <span class="hd-label">{{ it.label }}</span>
                <div class="hd-meta muted">
                  <span v-if="it.ready">备齐：{{ it.ready_by }} · {{ fmt(it.ready_at) }}</span>
                  <span v-if="it.confirmed">确认：{{ it.confirmed_by }} · {{ fmt(it.confirmed_at) }}</span>
                </div>
              </div>
              <div class="hd-acts">
                <button class="chip ready-chip" :class="{ on: it.ready }"
                        :disabled="!isRecruiter || o.status !== 'handover' || (it.confirmed && isRecruiter)"
                        :title="isRecruiter ? '' : '备齐由招聘负责人操作'"
                        @click="toggleReady(o, it.key)">{{ it.ready ? '✓ 已备齐' : '备齐' }}</button>
                <button class="chip confirm-chip" :class="{ on: it.confirmed }"
                        :disabled="!isManager || o.status !== 'handover'"
                        :title="isManager ? '' : '确认由用人经理操作'"
                        @click="toggleConfirm(o, it.key)">{{ it.confirmed ? '✓ 已确认' : '确认' }}</button>
              </div>
            </div>
          </div>
          <div class="phase-acts" v-if="o.status === 'handover'">
            <span class="muted" v-if="!allReady(o)">待备齐 {{ o.handover_total - o.ready_count }} 项</span>
            <span class="muted warn-text" v-else-if="!allConfirmed(o)">已全部备齐，待用人经理确认（{{ o.confirmed_count }}/{{ o.handover_total }}）</span>
            <button class="succ" :disabled="!isManager || !allConfirmed(o) || busy(o, 'ob-done')"
              :title="allConfirmed(o) ? '用人经理确认完成交接' : '全部交接项确认后方可完成'"
              @click="complete(o)">🎉 完成入职交接</button>
          </div>
          <div class="done-banner" v-else>
            🎉 全部 {{ o.handover_total }} 项交接内容已于 {{ fmt(o.completed_at) }} 备齐并确认，候选人正式进入试用期
          </div>
        </div>

        <!-- 取消留痕 -->
        <div class="cancel-banner" v-if="o.status === 'cancelled'">
          🚫 交接已于 {{ fmt(o.cancelled_at) }} 取消：{{ o.cancel_reason || '—' }}（可在候选人录用记录上重新发起）
        </div>

        <!-- 操作历史 -->
        <div class="logs-head" @click="toggleLogs(o.id)">
          <span class="muted">{{ showLogs[o.id] ? '▾' : '▸' }} 交接操作记录（{{ o.logs.length }}）</span>
        </div>
        <div class="logs" v-if="showLogs[o.id]">
          <div class="log" v-for="l in o.logs" :key="l.id">
            <span class="log-phase">{{ { material: '资料', approval: '审批', report: '报到', handover: '交接' }[l.phase] || '—' }}</span>
            <b>{{ l.action_label }}</b>
            <span class="muted">{{ l.content }}</span>
            <em class="muted log-time">{{ fmt(l.created_at) }} · {{ l.actor_name || '系统' }}</em>
          </div>
        </div>
      </div>
      <div class="card empty" v-if="!list.length">
        {{ filter === 'active' ? '暂无进行中的入职交接，已接受 Offer 的候选人可发起交接。' : '暂无历史交接记录。' }}
      </div>
    </div>

    <!-- 发起交接 -->
    <div class="modal" v-if="startTarget" @click.self="startTarget = null">
      <div class="modal-box card">
        <h3>🧳 发起入职交接 · {{ startTarget.candidate }}</h3>
        <div class="muted">{{ startTarget.position }} · {{ startTarget.dept }}
          · Offer {{ startTarget.offer?.status === 'joined' ? '已入职（历史确认，将补建交接）' : '已接受' }}</div>
        <label class="muted dl">预计报到日期（可在资料确认阶段调整）</label>
        <input type="date" v-model="startDate" />
        <div class="acts">
          <button class="primary" @click="submitStart">发起交接</button>
          <button class="ghost" @click="startTarget = null">取消</button>
        </div>
      </div>
    </div>

    <!-- 报到延期 -->
    <div class="modal" v-if="delayTarget" @click.self="delayTarget = null">
      <div class="modal-box card">
        <h3>⏳ 报到延期 · {{ delayTarget.candidate }}</h3>
        <div class="muted">原预计报到：{{ fmt(delayTarget.expected_onboard_at) || '待定' }}（已延期 {{ delayTarget.delay_count }} 次）</div>
        <label class="muted dl">新的预计报到日期</label>
        <input type="date" v-model="delayDate" />
        <label class="muted dl">延期原因（必填，将通知用人经理）</label>
        <textarea v-model="delayReason" rows="2" placeholder="如：候选人离职手续尚未办结"></textarea>
        <div class="acts">
          <button class="primary" @click="submitDelay">登记延期</button>
          <button class="ghost" @click="delayTarget = null">取消</button>
        </div>
      </div>
    </div>

    <!-- 取消交接 -->
    <div class="modal" v-if="cancelTarget" @click.self="cancelTarget = null">
      <div class="modal-box card">
        <h3>🚫 取消入职交接 · {{ cancelTarget.candidate }}</h3>
        <div class="muted">取消后候选人仍保留录用/Offer 记录，之后可重新发起交接；审批中任务会同步撤销。</div>
        <label class="muted dl">取消原因（必填）</label>
        <textarea v-model="cancelReason" rows="2" placeholder="如：候选人放弃入职"></textarea>
        <div class="acts">
          <button class="warn" @click="submitCancel">确认取消</button>
          <button class="ghost" @click="cancelTarget = null">返回</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ob { display: flex; flex-direction: column; gap: 14px; }
.intro { padding: 10px 14px; font-size: 12.5px; color: var(--muted); background: rgba(91,140,255,.07); border-color: rgba(91,140,255,.28); }
.intro b { color: var(--accent); font-weight: 600; margin: 0 2px; }
.stat-row { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; }
@media (max-width: 1100px) { .stat-row { grid-template-columns: repeat(3, 1fr); } }
.stat { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 12px 6px; }
.stat span { font-size: 19px; }
.stat b { font-size: 21px; }
.stat em { font-style: normal; font-size: 11.5px; color: var(--muted); }
.tabs { display: flex; gap: 8px; }
.tabs button { padding: 7px 14px; font-size: 13px; opacity: .8; }
.tabs button.on { opacity: 1; border-color: var(--accent); background: rgba(91,140,255,.15); color: var(--accent); }
.start-list { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
.start-item { display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--panel2); flex-wrap: wrap; }
.si-main { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 13.5px; }
.of-chip { font-size: 10.5px; border-radius: 9px; padding: 2px 8px; border: 1px solid var(--border); color: var(--muted); }
.of-chip.joined { color: var(--green); border-color: rgba(87,214,160,.4); background: rgba(87,214,160,.08); }
.of-chip.accepted { color: var(--accent2); border-color: rgba(255,209,102,.4); background: rgba(255,209,102,.08); }
.ob-list { display: flex; flex-direction: column; gap: 12px; }
.ob-card { padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
.ob-card.st-cancelled { opacity: .85; }
.ob-head { display: flex; align-items: center; gap: 10px; }
.ob-id { display: flex; align-items: baseline; gap: 10px; }
.ob-id b { font-size: 15px; }
.ob-no { margin-left: auto; font-style: normal; font-size: 11.5px; }
.ob-status { font-size: 11.5px; border: 1px solid; border-radius: 11px; padding: 2px 9px; white-space: nowrap; }
.stepper { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.stepper .step { display: flex; align-items: center; gap: 6px; font-size: 12px;
  padding: 5px 11px; border-radius: 14px; border: 1px solid var(--border); color: var(--muted); background: var(--panel2); }
.stepper .step.done { color: var(--green); border-color: rgba(87,214,160,.4); background: rgba(87,214,160,.08); }
.stepper .step.current { color: var(--accent); border-color: rgba(91,140,255,.5); background: rgba(91,140,255,.12); box-shadow: 0 0 0 2px rgba(91,140,255,.1); }
.stepper .step.dead { opacity: .5; }
.stepper .arrow { font-style: normal; color: var(--muted); font-size: 11px; }
.phase { border: 1px solid var(--border); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 10px; background: rgba(255,255,255,.015); }
.phase-title { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.phase-title h4 { font-size: 13.5px; }
.phase-title .muted { font-size: 11.5px; }
.mat-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 7px; }
@media (max-width: 900px) { .mat-grid { grid-template-columns: 1fr; } }
.mat-item { display: flex; align-items: center; gap: 8px; font-size: 12.5px; padding: 7px 9px;
  border: 1px solid var(--border); border-radius: 8px; background: var(--panel2); cursor: pointer; }
.mat-item.done { border-color: rgba(87,214,160,.35); background: rgba(87,214,160,.06); }
.mat-item.locked { cursor: default; }
.mat-item input { margin: 0; }
.mat-item em { margin-left: auto; font-style: normal; font-size: 10.5px; }
.mat-foot { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.cand-confirm { display: flex; align-items: center; gap: 7px; font-size: 12.5px; padding: 6px 10px;
  border: 1px dashed var(--border); border-radius: 8px; cursor: pointer; }
.cand-confirm.on { color: var(--green); border-color: rgba(87,214,160,.5); border-style: solid; background: rgba(87,214,160,.07); }
.expect-date { display: flex; align-items: center; gap: 7px; font-size: 12.5px; margin-left: auto; }
.expect-date input { padding: 5px 8px; }
.phase-acts { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.warn-text { color: var(--accent2); }
button.sm { font-size: 11px; padding: 4px 9px; }
.approval-box { display: flex; flex-direction: column; gap: 10px; }
.ap-info { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; font-size: 12.5px; }
.ap-route { display: flex; align-items: center; gap: 8px; font-size: 12.5px; }
.ap-route .node { padding: 4px 10px; border-radius: 12px; border: 1px solid var(--border); color: var(--muted); background: var(--panel2); }
.ap-route .node.done { color: var(--green); border-color: rgba(87,214,160,.4); }
.ap-route .node.current { color: var(--accent2); border-color: rgba(255,209,102,.5); background: rgba(255,209,102,.1); }
.ap-route em { font-style: normal; color: var(--muted); }
.report-info { display: flex; align-items: center; gap: 14px; font-size: 13px; flex-wrap: wrap; }
.delay-chip { font-size: 11px; color: var(--accent2); border: 1px solid rgba(255,209,102,.4); background: rgba(255,209,102,.1); border-radius: 10px; padding: 1px 8px; }
.hd-list { display: flex; flex-direction: column; gap: 7px; }
.hd-item { display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 9px 11px; border: 1px solid var(--border); border-radius: 9px; background: var(--panel2); flex-wrap: wrap; }
.hd-item.ready { border-color: rgba(91,140,255,.35); }
.hd-item.confirmed { border-color: rgba(87,214,160,.45); background: rgba(87,214,160,.05); }
.hd-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.hd-label { font-size: 13px; }
.hd-meta { display: flex; gap: 10px; font-size: 10.5px; flex-wrap: wrap; }
.hd-acts { display: flex; gap: 6px; }
.chip { font-size: 11px; padding: 4px 10px; border-radius: 11px; border: 1px solid var(--border); color: var(--muted); background: transparent; }
.chip:disabled { opacity: .5; cursor: not-allowed; }
.ready-chip.on { color: var(--accent); border-color: rgba(91,140,255,.5); background: rgba(91,140,255,.12); }
.confirm-chip.on { color: var(--green); border-color: rgba(87,214,160,.5); background: rgba(87,214,160,.12); }
.done-banner { font-size: 13px; color: var(--green); background: rgba(87,214,160,.08); border: 1px solid rgba(87,214,160,.3); border-radius: 9px; padding: 9px 12px; }
.cancel-banner { font-size: 12.5px; color: var(--muted); background: rgba(255,107,122,.06); border: 1px solid rgba(255,107,122,.25); border-radius: 9px; padding: 9px 12px; }
.logs-head { cursor: pointer; user-select: none; font-size: 12px; }
.logs { display: flex; flex-direction: column; gap: 5px; border-top: 1px dashed var(--border); padding-top: 9px; }
.log { display: flex; align-items: baseline; gap: 9px; font-size: 12px; flex-wrap: wrap; }
.log-phase { font-size: 10px; color: var(--accent); border: 1px solid rgba(91,140,255,.35); background: rgba(91,140,255,.08); border-radius: 8px; padding: 0 7px; }
.log-time { margin-left: auto; font-style: normal; font-size: 10.5px; }
.modal-box .dl { display: block; margin: 10px 0 4px; font-size: 12px; }
.modal-box input, .modal-box textarea { width: 100%; }
.empty { padding: 26px; text-align: center; color: var(--muted); }
</style>
