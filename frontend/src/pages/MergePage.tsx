import { useMemo, useRef, useState } from 'react'
import type { SiteChoice, SquadPacket, MergePlan, MergeStats } from '@/types/merge'
import { SITE_FAR_THRESHOLD_METERS } from '@/types/merge'
import { usePersistentStore } from '@/hooks/usePersistentStore'
import { specimenStore } from '@/stores/specimenStore'
import { siteStore } from '@/stores/siteStore'
import { storageStore } from '@/stores/storageStore'
import { determinationStore } from '@/stores/determinationStore'
import {
  DETENTION_PROTECTED_FIELDS,
  buildMergePlan,
  commitMergePlan,
  parseSquadPacket,
  summarizePlan,
  unresolvedSiteChoices
} from '@/utils/merge'
import { buildDemoPacket, exportSquadPacket } from '@/utils/squadPacket'
import { downloadJson } from '@/utils/export'
import { formatLatLng, encodeSlot } from '@/utils/codec'

const DET_ACTION_LABEL: Record<string, string> = {
  'add-to-new-specimen': '随新标本并入',
  append: '补入主台账（该标本原无鉴定结论）',
  'skip-duplicate': '已存在同条鉴定记录，跳过',
  'skip-master-determined': '主台账已有鉴定结论，不覆盖'
}

const STG_ACTION_LABEL: Record<string, string> = {
  'add-to-new-specimen': '随新标本并入',
  'fill-empty': '补入主台账（该标本原未入柜）',
  'skip-occupied-master': '主台账已有柜位，不覆盖',
  'skip-slot-conflict': '目标柜位被占用'
}

function displayValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—'
  return String(value)
}

/** 台账并账：分队离线数据包合回主台账，冲突按业务规则取数，整批事务提交、可安全重试 */
export default function MergePage(): JSX.Element {
  const specimens = usePersistentStore(specimenStore, (state) => state.rows)
  const sites = usePersistentStore(siteStore, (state) => state.rows)
  const determinations = usePersistentStore(determinationStore, (state) => state.rows)
  const storages = usePersistentStore(storageStore, (state) => state.rows)

  const [squadName, setSquadName] = useState('')
  const [packet, setPacket] = useState<SquadPacket | null>(null)
  const [fileName, setFileName] = useState('')
  const [loadError, setLoadError] = useState('')
  const [choices, setChoices] = useState<Record<string, SiteChoice>>({})
  const [result, setResult] = useState<MergeStats | null>(null)
  const [commitError, setCommitError] = useState('')
  const [committing, setCommitting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const planState = useMemo<{ plan: MergePlan | null; error: string }>(() => {
    if (!packet) return { plan: null, error: '' }
    try {
      const plan = buildMergePlan(
        packet,
        { sites, specimens, determinations, storages },
        choices
      )
      return { plan, error: '' }
    } catch (error) {
      return { plan: null, error: error instanceof Error ? error.message : '预检失败' }
    }
    // choices 为对象，队长每次裁决都会产生新引用
  }, [packet, choices, sites, specimens, determinations, storages])

  const plan = planState.plan
  const summary = plan ? summarizePlan(plan) : null
  const farSites = plan ? unresolvedSiteChoices(plan) : []
  const decidedFarSites = plan ? plan.sites.filter((item) => item.kind === 'far') : []

  const loadPacket = (next: SquadPacket, name: string): void => {
    setPacket(next)
    setFileName(name)
    setChoices({})
    setResult(null)
    setCommitError('')
    setLoadError('')
  }

  const onFile = async (file: File | undefined): Promise<void> => {
    if (!file) return
    try {
      const text = await file.text()
      loadPacket(parseSquadPacket(text), file.name)
    } catch (error) {
      setPacket(null)
      setLoadError(error instanceof Error ? error.message : '文件读取失败')
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const chooseSite = (code: string, choice: SiteChoice): void => {
    setChoices((prev) => ({ ...prev, [code]: choice }))
    setResult(null)
    setCommitError('')
  }

  const doExport = (): void => {
    exportSquadPacket(squadName || '未命名分队', { sites, specimens, determinations, storages })
  }

  const doCommit = async (): Promise<void> => {
    if (!plan || farSites.length > 0) return
    setCommitting(true)
    setCommitError('')
    try {
      const stats = await commitMergePlan(plan)
      await siteStore.getState().hydrate()
      await specimenStore.getState().hydrate()
      await determinationStore.getState().hydrate()
      await storageStore.getState().hydrate()
      setResult(stats)
    } catch (error) {
      // Dexie 事务已整体回滚；此前成功提交的其他批次不受影响，可原样重试本批
      setCommitError(error instanceof Error ? error.message : '并账失败，本批已整体回滚')
    } finally {
      setCommitting(false)
    }
  }

  const changedExisting = plan?.specimens.filter((item) => item.kind === 'existing') ?? []
  const newSpecimens = plan?.specimens.filter((item) => item.kind === 'new') ?? []
  const addedDets = plan?.determinations.filter((item) => item.output !== null) ?? []
  const skippedDets = plan?.determinations.filter((item) => item.output === null) ?? []
  const addedStgs = plan?.storages.filter((item) => item.output !== null) ?? []
  const skippedStgs = plan?.storages.filter((item) => item.output === null) ?? []

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="page-title">台账并账</h1>
        <p className="page-sub">
          分队离线各记各的标本，回营后导出数据包交队长合回主台账：分类与采集信息认先登记一份，鉴定结论与保藏柜位不被后来这份覆盖；
          采集地同代码而坐标相差超过 {SITE_FAR_THRESHOLD_METERS} 米的，先由队长裁决。提交为整批事务，失败整体回滚，可安全重试且不会多出条目。
        </p>
      </header>

      <section className="panel grid gap-3 md:grid-cols-[1fr_auto_auto] md:items-end">
        <div>
          <span className="field-label">分队名称（写进数据包，用于冲突溯源）</span>
          <input
            className="field-input"
            value={squadName}
            onChange={(e) => setSquadName(e.target.value)}
            placeholder="如 甲组分队 · 韩涧"
          />
        </div>
        <button className="btn-primary" type="button" onClick={doExport}>
          导出本机分队数据包
        </button>
        <button
          className="btn-ghost"
          type="button"
          onClick={() => {
            const demo = buildDemoPacket()
            downloadJson(`分队台账-${demo.squadName}-演示.json`, demo)
            loadPacket(demo, `${demo.squadName}（演示包）`)
          }}
        >
          下载并载入演示数据包
        </button>
      </section>

      <section className="panel flex flex-wrap items-end gap-3">
        <div>
          <span className="field-label">队长：选择分队数据包（.json）</span>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="block text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-field-600 file:px-3 file:py-2 file:text-sm file:text-white hover:file:bg-field-700"
            onChange={(e) => void onFile(e.target.files?.[0])}
          />
        </div>
        <button
          className="btn-ghost"
          type="button"
          onClick={() => loadPacket(buildDemoPacket(), '甲组分队（演示包）')}
        >
          直接载入演示包预检
        </button>
        {fileName ? <span className="text-xs text-slate-500">当前预检：{fileName}</span> : null}
        {loadError ? <p className="w-full text-sm text-rose-600">{loadError}</p> : null}
        {planState.error ? <p className="w-full text-sm text-rose-600">{planState.error}</p> : null}
      </section>

      {plan && summary ? (
        <>
          <section className="panel">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-slate-800">
                  数据包：{plan.packet.squadName}
                </h2>
                <p className="text-xs text-slate-500">
                  导出时间 {plan.packet.exportedAt} · 包内标本 {plan.packet.specimens.length} 份 · 采集地{' '}
                  {plan.packet.sites.length} 处 · 鉴定记录 {plan.packet.determinations.length} 条 · 保藏记录{' '}
                  {plan.packet.storages.length} 条
                </p>
              </div>
              <div className="flex flex-wrap gap-2 text-xs">
                <span className="rounded-full bg-field-50 px-3 py-1 text-field-700">新采集地 {summary.newSites}</span>
                <span className="rounded-full bg-field-50 px-3 py-1 text-field-700">新标本 {summary.newSpecimens}</span>
                <span className="rounded-full bg-field-50 px-3 py-1 text-field-700">同编号比对 {summary.existingSpecimens}（字段有差异 {summary.changedSpecimens}）</span>
                <span className="rounded-full bg-field-50 px-3 py-1 text-field-700">鉴定补入 {summary.determinationsAdded} / 跳过 {summary.determinationsSkipped}</span>
                <span className="rounded-full bg-field-50 px-3 py-1 text-field-700">柜位补入 {summary.storagesAdded} / 跳过 {summary.storagesSkipped}</span>
                {farSites.length > 0 ? (
                  <span className="rounded-full bg-amber-100 px-3 py-1 font-medium text-amber-800">
                    待裁决采集地 {farSites.length}
                  </span>
                ) : null}
              </div>
            </div>
          </section>

          {decidedFarSites.length > 0 ? (
            <section className="panel flex flex-col gap-3">
              <h2 className="text-sm font-semibold text-slate-800">
                采集地坐标裁决（同代码、距离 &gt; {SITE_FAR_THRESHOLD_METERS} 米）
              </h2>
              {decidedFarSites.map((site) => {
                const pending = !site.choice
                return (
                  <div
                    key={site.code}
                    className={`rounded-lg border p-3 ${pending ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-slate-50'}`}
                  >
                    <p className="text-sm font-medium text-slate-800">
                      <span className="font-mono text-field-700">{site.code}</span> 两点相距约 {site.distance} 米
                    </p>
                    <div className="mt-2 grid gap-2 text-xs md:grid-cols-2">
                      <div className={`rounded-lg border p-2 ${site.choice === 'master' ? 'border-field-500 bg-white' : 'border-slate-200 bg-white/70'}`}>
                        <p className="font-semibold text-slate-700">主台账：{site.master?.name}</p>
                        <p className="text-slate-500">{formatLatLng(site.master?.longitude ?? 0, site.master?.latitude ?? 0)} · {site.master?.altitude} m · {site.master?.habitat}</p>
                      </div>
                      <div className={`rounded-lg border p-2 ${site.choice === 'squad' ? 'border-field-500 bg-white' : 'border-slate-200 bg-white/70'}`}>
                        <p className="font-semibold text-slate-700">分队：{site.squad.name}</p>
                        <p className="text-slate-500">{formatLatLng(site.squad.longitude, site.squad.latitude)} · {site.squad.altitude} m · {site.squad.habitat}</p>
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        className={site.choice === 'master' ? 'btn-primary' : 'btn-ghost'}
                        onClick={() => chooseSite(site.code, 'master')}
                      >
                        保留主台账坐标
                      </button>
                      <button
                        type="button"
                        className={site.choice === 'squad' ? 'btn-primary' : 'btn-ghost'}
                        onClick={() => chooseSite(site.code, 'squad')}
                      >
                        采用分队坐标与描述
                      </button>
                      {site.choice ? (
                        <span className="text-xs text-field-700">
                          已选择：{site.choice === 'master' ? '主台账' : '分队'}（标本归属自动挂到保留的采集地）
                        </span>
                      ) : (
                        <span className="text-xs font-medium text-amber-800">未裁决前不能提交</span>
                      )}
                    </div>
                  </div>
                )
              })}
            </section>
          ) : null}

          <section className="panel">
            <h2 className="text-sm font-semibold text-slate-800">标本字段取数（同编号两边都动过）</h2>
            <p className="mt-1 text-xs text-slate-500">
              分类与采集信息按登记时间认早的一份；鉴定状态、鉴定人属于鉴定结论，主台账现值不被覆盖。
            </p>
            <div className="mt-3 flex flex-col gap-3">
              {changedExisting.map((item) => {
                const changedFields = item.fields.filter((field) => field.changed)
                const masterTime = item.master?.registeredAt ?? '—'
                const squadTime = item.squad.registeredAt
                return (
                  <article key={item.code} className="rounded-lg border border-slate-200 p-3">
                    <header className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="font-mono text-xs text-field-700">{item.code}</h3>
                      <span className="rounded-full bg-field-50 px-2 py-0.5 text-[11px] text-field-700">
                        分类/采集取数：{item.taxonWinner === 'squad' ? '分队（登记更早）' : '主台账（登记更早或并列）'}
                      </span>
                    </header>
                    <p className="mt-1 text-[11px] text-slate-400">
                      主台账登记 {displayValue(masterTime)} ｜ 分队登记 {displayValue(squadTime)}
                    </p>
                    <div className="mt-2 overflow-x-auto">
                      <table className="w-full min-w-[640px] border-collapse text-xs">
                        <thead>
                          <tr className="bg-slate-50 text-left text-slate-500">
                            <th className="border border-slate-200 px-2 py-1">字段</th>
                            <th className="border border-slate-200 px-2 py-1">主台账</th>
                            <th className="border border-slate-200 px-2 py-1">分队</th>
                            <th className="border border-slate-200 px-2 py-1">取数</th>
                          </tr>
                        </thead>
                        <tbody>
                          {changedFields.map((field) => (
                            <tr key={field.key}>
                              <td className="border border-slate-200 px-2 py-1 text-slate-500">{field.label}</td>
                              <td className={`border border-slate-200 px-2 py-1 ${field.winner === 'master' ? 'font-semibold text-field-700' : 'text-slate-500'}`}>
                                {displayValue(field.master)}
                              </td>
                              <td className={`border border-slate-200 px-2 py-1 ${field.winner === 'squad' ? 'font-semibold text-field-700' : 'text-slate-500'}`}>
                                {displayValue(field.squad)}
                              </td>
                              <td className="border border-slate-200 px-2 py-1">{field.winner === 'master' ? '主台账' : '分队'}</td>
                            </tr>
                          ))}
                          {DETENTION_PROTECTED_FIELDS.map(({ key, label }) => (
                            <tr key={key} className="bg-slate-50/60">
                              <td className="border border-slate-200 px-2 py-1 text-slate-500">{label}（保护）</td>
                              <td className="border border-slate-200 px-2 py-1 font-semibold text-field-700">
                                {item.master ? displayValue(item.master[key]) : '—'}
                              </td>
                              <td className="border border-slate-200 px-2 py-1 text-slate-400 line-through">
                                {displayValue(item.squad[key])}
                              </td>
                              <td className="border border-slate-200 px-2 py-1 text-slate-500">主台账，不覆盖</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </article>
                )
              })}
              {changedExisting.length === 0 ? <p className="text-xs text-slate-400">没有同编号标本需要比对</p> : null}
            </div>
            {newSpecimens.length > 0 ? (
              <div className="mt-3 rounded-lg bg-field-50 p-3 text-xs text-field-700">
                <p className="font-medium">分队新增标本 {newSpecimens.length} 份（编号直接并入）：</p>
                <p className="mt-1 font-mono">{newSpecimens.map((item) => item.code).join('、')}</p>
              </div>
            ) : null}
          </section>

          <section className="grid gap-4 md:grid-cols-2">
            <div className="panel">
              <h2 className="text-sm font-semibold text-slate-800">
                鉴定结论（补入 {addedDets.length} · 不覆盖 {skippedDets.length}）
              </h2>
              <ul className="mt-2 space-y-1.5 text-xs">
                {addedDets.map((item) => (
                  <li key={item.squad.id} className="rounded-lg border border-field-200 bg-field-50 px-2 py-1.5">
                    <span className="font-mono text-field-700">{item.specimenCode}</span> · {item.squad.conclusion}（{item.squad.determiner}）
                    <span className="ml-1 text-field-600">→ {DET_ACTION_LABEL[item.action]}</span>
                  </li>
                ))}
                {skippedDets.map((item) => (
                  <li key={item.squad.id} className="rounded-lg border border-slate-200 px-2 py-1.5 text-slate-500">
                    <span className="font-mono">{item.specimenCode}</span> · {item.squad.conclusion}（{item.squad.determiner}）
                    <span className="ml-1">→ {DET_ACTION_LABEL[item.action]}</span>
                  </li>
                ))}
                {addedDets.length + skippedDets.length === 0 ? <li className="text-slate-400">包内无鉴定记录</li> : null}
              </ul>
            </div>

            <div className="panel">
              <h2 className="text-sm font-semibold text-slate-800">
                保藏柜位（补入 {addedStgs.length} · 跳过 {skippedStgs.length}）
              </h2>
              <ul className="mt-2 space-y-1.5 text-xs">
                {addedStgs.map((item) => (
                  <li key={item.squad.id} className="rounded-lg border border-field-200 bg-field-50 px-2 py-1.5">
                    <span className="font-mono text-field-700">{item.specimenCode}</span> · {item.squad.method}{' '}
                    {item.output ? encodeSlot(item.output.cabinet, item.output.drawer, item.output.box, item.output.slot) : ''}
                    <span className="ml-1 text-field-600">→ {STG_ACTION_LABEL[item.action]}</span>
                  </li>
                ))}
                {skippedStgs.map((item) => (
                  <li key={item.squad.id} className="rounded-lg border border-slate-200 px-2 py-1.5 text-slate-500">
                    <span className="font-mono">{item.specimenCode}</span> · {item.squad.method}{' '}
                    {encodeSlot(item.squad.cabinet, item.squad.drawer, item.squad.box, item.squad.slot)}
                    <span className="ml-1">→ {STG_ACTION_LABEL[item.action]}（{item.conflict ?? ''}）</span>
                  </li>
                ))}
                {addedStgs.length + skippedStgs.length === 0 ? <li className="text-slate-400">包内无保藏记录</li> : null}
              </ul>
            </div>
          </section>

          <section className="panel flex flex-wrap items-center gap-3">
            <button className="btn-primary" type="button" disabled={farSites.length > 0 || committing} onClick={() => void doCommit()}>
              {committing ? '提交中…' : `确认并账（${plan.packet.squadName}）`}
            </button>
            {farSites.length > 0 ? (
              <span className="text-xs font-medium text-amber-700">还有 {farSites.length} 处采集地坐标未裁决</span>
            ) : (
              <span className="text-xs text-slate-500">
                四表在同一事务内提交；任何一步失败整批回滚，已并好的其他批次不受影响，本批可重新选择文件原样重试。
              </span>
            )}
            {commitError ? <p className="w-full text-sm text-rose-600">{commitError}（本批未写入，主台账维持原状）</p> : null}
            {result ? (
              <div className="w-full rounded-lg border border-field-200 bg-field-50 p-3 text-sm text-field-700">
                <p className="font-semibold">「{result.squadName}」并账完成：</p>
                <p className="mt-1 text-xs">
                  采集地新增 {result.sitesInserted} / 覆盖 {result.sitesUpdated}；标本新增 {result.specimensInserted} /
                  字段更新 {result.specimensUpdated}；鉴定记录补入 {result.determinationsAdded}；柜位补入 {result.storagesAdded}
                  {result.storageSkipped.length > 0 ? `；柜位跳过：${result.storageSkipped.join('、')}` : ''}。
                </p>
                <p className="mt-1 text-xs text-field-600">同一份数据包再次提交不会多出条目（确定性编号 + 业务键去重）。</p>
              </div>
            ) : null}
          </section>
        </>
      ) : null}
    </div>
  )
}
