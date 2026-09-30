import { useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { usePersistentStore } from '@/hooks/usePersistentStore'
import { specimenStore } from '@/stores/specimenStore'
import { siteStore } from '@/stores/siteStore'
import { storageStore } from '@/stores/storageStore'
import { determinationStore } from '@/stores/determinationStore'
import { applyMerge, parseMergeFile, planMerge } from '@/utils/merge'
import type { MergeFile, MergePlan, SiteResolution, SitePlan, SpecimenPlan } from '@/utils/merge'
import { downloadBackup } from '@/utils/export'

type Stage = 'idle' | 'parsed' | 'applied'

/** 野外记录合并：导入分队离线备份，按业务规则合并回队里的主台账 */
export default function MergePage(): JSX.Element {
  const specimens = usePersistentStore(specimenStore, (state) => state.rows)
  const sites = usePersistentStore(siteStore, (state) => state.rows)
  const storages = usePersistentStore(storageStore, (state) => state.rows)
  const determinations = usePersistentStore(determinationStore, (state) => state.rows)

  const fileInput = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState('')
  const [parseError, setParseError] = useState('')
  const [file, setFile] = useState<MergeFile | null>(null)
  const [resolutions, setResolutions] = useState<Record<string, SiteResolution>>({})
  const [stage, setStage] = useState<Stage>('idle')
  const [applying, setApplying] = useState(false)
  const [result, setResult] = useState<Awaited<ReturnType<typeof applyMerge>> | null>(null)
  const [appliedStats, setAppliedStats] = useState<MergePlan['stats'] | null>(null)

  const plan: MergePlan | null = useMemo(() => {
    if (!file) return null
    return planMerge({ sites, specimens, determinations, storages }, file, resolutions)
  }, [file, resolutions, sites, specimens, determinations, storages])

  const onPickFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const selected = event.target.files?.[0]
    if (!selected) return
    const text = await selected.text()
    const parsed = parseMergeFile(text)
    if (!parsed.ok) {
      setParseError(parsed.error)
      setFile(null)
      setPlanState('idle')
      return
    }
    setParseError('')
    setFileName(selected.name)
    setFile(parsed.data)
    setPlanState('parsed')
  }

  const setPlanState = (next: Stage): void => {
    setStage(next)
    setResult(null)
  }

  const reset = (): void => {
    setFile(null)
    setFileName('')
    setParseError('')
    setResolutions({})
    setAppliedStats(null)
    setPlanState('idle')
    if (fileInput.current) fileInput.current.value = ''
  }

  const setResolution = (key: string, value: SiteResolution): void => {
    setResolutions((prev) => ({ ...prev, [key]: value }))
  }

  const apply = async (): Promise<void> => {
    if (!plan) return
    setApplying(true)
    setResult(null)
    try {
      const res = await applyMerge(plan)
      setResult(res)
      const allOk = Object.values(res).every((item) => item.ok)
      // 无论是否全部成功都回填：已提交的表进入内存镜像，重试时计划会自动跳过它们
      await Promise.all([
        siteStore.getState().hydrate(),
        specimenStore.getState().hydrate(),
        determinationStore.getState().hydrate(),
        storageStore.getState().hydrate()
      ])
      if (allOk) {
        setAppliedStats(plan.stats)
        setStage('applied')
      }
    } finally {
      setApplying(false)
    }
  }

  const exportBackup = (): void => {
    downloadBackup('野外记录备份.json', {
      sites,
      specimens,
      storages,
      determinations
    })
  }

  const conflictCount = plan?.stats.sitesConflict ?? 0
  const hasFailure = result ? Object.values(result).some((item) => !item.ok) : false

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">野外记录合并</h1>
          <p className="page-sub">
            分队离线记完标本后，把备份 JSON 合并回队里的主台账：同编号两边都动过时，分类与采集信息认先登记的那份，
            鉴定结论与保藏柜位以主台账为准不会被盖掉；同代码坐标差得远的采集地会先请队长确认。
          </p>
        </div>
        <button className="btn-ghost" type="button" onClick={exportBackup}>
          导出当前台账备份
        </button>
      </header>

      <section className="panel flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-slate-700">第一步：选择分队离线备份文件</h2>
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            className="field-input max-w-md"
            onChange={(e) => void onPickFile(e)}
          />
          {fileName ? <span className="text-xs text-slate-500">已选择：{fileName}</span> : null}
          {file ? (
            <button className="btn-ghost" type="button" onClick={reset}>
              重新选择
            </button>
          ) : null}
        </div>
        {parseError ? <p className="text-sm text-rose-600">{parseError}</p> : null}
        <p className="text-xs text-slate-400">
          备份文件可由右上角「导出当前台账备份」生成；合并按标本编号与采集地代码匹配，重复导入不会多出条目。
        </p>
      </section>

      {plan ? (
        <>
          <section className="panel flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-slate-700">第二步：核对合并计划</h2>
            <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="新增标本" value={plan.stats.specimensAdd} tone="green" />
              <Stat label="合并标本" value={plan.stats.specimensMerge} tone="blue" />
              <Stat label="新增采集地" value={plan.stats.sitesAdd} tone="green" />
              <Stat label="采集地冲突待确认" value={plan.stats.sitesConflict} tone={conflictCount > 0 ? 'amber' : 'gray'} />
              <Stat label="新增鉴定记录" value={plan.stats.determinationsAdd} tone="green" />
              <Stat label="跳过鉴定（同份已存在）" value={plan.stats.determinationsSkip} tone="gray" />
              <Stat label="新增保藏柜位" value={plan.stats.storagesAdd} tone="green" />
              <Stat label="跳过柜位（主台账已入柜）" value={plan.stats.storagesSkip} tone="gray" />
            </dl>
            {plan.warnings.length > 0 ? (
              <ul className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">
                {plan.warnings.map((warning, index) => (
                  <li key={index}>· {warning}</li>
                ))}
              </ul>
            ) : null}
            {plan.exportedAt ? (
              <p className="text-xs text-slate-400">备份导出时间：{new Date(plan.exportedAt).toLocaleString('zh-CN')}</p>
            ) : null}
          </section>

          {conflictCount > 0 ? (
            <section className="panel flex flex-col gap-3">
              <h2 className="text-sm font-semibold text-slate-700">
                第三步：同代码、坐标差得远的采集地，请队长挑一下
              </h2>
              <div className="flex flex-col gap-3">
                {plan.sites
                  .filter((site) => site.decision === 'conflict' && site.local)
                  .map((site) => (
                    <SiteConflictCard
                      key={site.key}
                      plan={site}
                      resolution={resolutions[site.key] ?? 'local'}
                      onChange={(value) => setResolution(site.key, value)}
                    />
                  ))}
              </div>
            </section>
          ) : null}

          <section className="panel flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-slate-700">
              {conflictCount > 0 ? '第四步' : '第三步'}：确认合并
            </h2>
            <div className="flex flex-wrap items-center gap-3">
              <button className="btn-primary" type="button" disabled={applying} onClick={() => void apply()}>
                {applying ? '正在合并…' : '确认合并回主台账'}
              </button>
              <span className="text-xs text-slate-500">
                合并按表分批写入：某批失败会整批回滚，已写入的批次保留，修正后重试即可，不会重复。
              </span>
            </div>

            {result ? (
              <ul className="rounded-lg border border-slate-200 p-3 text-sm">
                <BatchResult name="采集地" ok={result.sites.ok} error={result.sites.error} />
                <BatchResult name="标本" ok={result.specimens.ok} error={result.specimens.error} />
                <BatchResult name="鉴定记录" ok={result.determinations.ok} error={result.determinations.error} />
                <BatchResult name="保藏柜位" ok={result.storages.ok} error={result.storages.error} />
              </ul>
            ) : null}

            {stage === 'applied' && !hasFailure && appliedStats ? (
              <p className="rounded-lg border border-field-100 bg-field-50 px-3 py-2 text-sm text-field-700">
                合并完成：新增标本 {appliedStats.specimensAdd} 份、合并 {appliedStats.specimensMerge} 份，新增采集地{' '}
                {appliedStats.sitesAdd} 个、鉴定记录 {appliedStats.determinationsAdd} 条、柜位 {appliedStats.storagesAdd} 个。
                同一文件可再次导入，已存在的记录会自动跳过。
              </p>
            ) : null}
          </section>

          {plan.specimens.some((item) => item.decision === 'merge' && item.changes.length > 0) ? (
            <section className="panel flex flex-col gap-3">
              <h2 className="text-sm font-semibold text-slate-700">合并标本明细（两边都动过的字段）</h2>
              <div className="flex flex-col gap-2">
                {plan.specimens
                  .filter((item) => item.decision === 'merge' && item.changes.length > 0 && item.local)
                  .map((item) => (
                    <SpecimenMergeRow key={item.key} plan={item} />
                  ))}
              </div>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone: 'green' | 'blue' | 'amber' | 'gray' }): JSX.Element {
  const tones: Record<string, string> = {
    green: 'border-field-200 bg-field-50 text-field-700',
    blue: 'border-sky-200 bg-sky-50 text-sky-700',
    amber: 'border-amber-300 bg-amber-50 text-amber-800',
    gray: 'border-slate-200 bg-slate-50 text-slate-500'
  }
  return (
    <div className={`rounded-lg border px-3 py-2 ${tones[tone]}`}>
      <dt className="text-xs">{label}</dt>
      <dd className="text-lg font-semibold" data-testid={`stat-${label}`}>
        {value}
      </dd>
    </div>
  )
}

function BatchResult({ name, ok, error }: { name: string; ok: boolean; error?: string }): JSX.Element {
  return (
    <li className="flex items-start gap-2 py-1">
      <span className={ok ? 'text-field-700' : 'text-rose-600'}>{ok ? '✓' : '✗'}</span>
      <span className="text-slate-700">
        {name}
        {ok ? '：已写入' : `：本批已回滚（${error ?? '未知错误'}）`}
      </span>
    </li>
  )
}

function SiteConflictCard({
  plan,
  resolution,
  onChange
}: {
  plan: SitePlan
  resolution: SiteResolution
  onChange: (value: SiteResolution) => void
}): JSX.Element {
  const local = plan.local!
  const inc = plan.incoming
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50/60 p-3">
      <p className="text-sm font-semibold text-amber-900">
        采集地代码 <span className="font-mono">{plan.key}</span> 两边都有，坐标相差约 {Math.round(plan.distance ?? 0)} 米
      </p>
      <div className="mt-2 grid gap-3 md:grid-cols-2">
        <label
          className={`cursor-pointer rounded-lg border p-3 text-sm ${
            resolution === 'local' ? 'border-field-500 bg-field-50' : 'border-slate-200 bg-white'
          }`}
        >
          <input
            type="radio"
            name={`site-${plan.key}`}
            className="mr-2 accent-field-600"
            checked={resolution === 'local'}
            onChange={() => onChange('local')}
          />
          <span className="font-medium text-slate-800">保留主台账采集地</span>
          <span className="mt-1 block text-xs text-slate-500">
            {local.name} · {local.region} · {local.longitude.toFixed(4)}, {local.latitude.toFixed(4)} · 海拔 {local.altitude}m
          </span>
        </label>
        <label
          className={`cursor-pointer rounded-lg border p-3 text-sm ${
            resolution === 'incoming' ? 'border-field-500 bg-field-50' : 'border-slate-200 bg-white'
          }`}
        >
          <input
            type="radio"
            name={`site-${plan.key}`}
            className="mr-2 accent-field-600"
            checked={resolution === 'incoming'}
            onChange={() => onChange('incoming')}
          />
          <span className="font-medium text-slate-800">采用分队导入的坐标</span>
          <span className="mt-1 block text-xs text-slate-500">
            {inc.name} · {inc.region} · {inc.longitude.toFixed(4)}, {inc.latitude.toFixed(4)} · 海拔 {inc.altitude}m
          </span>
        </label>
      </div>
    </div>
  )
}

function SpecimenMergeRow({ plan }: { plan: SpecimenPlan }): JSX.Element {
  const local = plan.local!
  return (
    <details className="rounded-lg border border-slate-200 bg-white p-3 text-sm">
      <summary className="cursor-pointer font-mono text-field-700">
        {plan.key} <span className="ml-2 font-sans text-xs text-slate-500">分类/采集信息采用「{plan.winner === 'incoming' ? '分队先登记' : '主台账先登记'}」</span>
      </summary>
      <table className="mt-2 w-full min-w-[560px] border-collapse text-xs">
        <thead>
          <tr className="bg-slate-50 text-left text-slate-500">
            <th className="border border-slate-200 px-2 py-1">字段</th>
            <th className="border border-slate-200 px-2 py-1">主台账</th>
            <th className="border border-slate-200 px-2 py-1">分队导入</th>
            <th className="border border-slate-200 px-2 py-1">采用</th>
          </tr>
        </thead>
        <tbody>
          {plan.changes.map((change) => (
            <tr key={change.field}>
              <td className="border border-slate-200 px-2 py-1">{change.label}</td>
              <td className="border border-slate-200 px-2 py-1">{String(change.local ?? '—')}</td>
              <td className="border border-slate-200 px-2 py-1">{String(change.incoming ?? '—')}</td>
              <td className="border border-slate-200 px-2 py-1">
                {change.winner === 'incoming' ? '分队（先登记）' : '主台账'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-slate-400">
        鉴定状态 {local.status}、鉴定人 {local.determiner || '—'} 以主台账为准，不随导入覆盖。
      </p>
    </details>
  )
}
