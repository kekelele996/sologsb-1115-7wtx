import type { CollectSite, Determination, Specimen, Storage } from '@/types'
import { distanceMeters } from '@/types'
import { db } from '@/hooks/usePersistentStore'

/** 采集地代码相同、坐标相差超过该距离（米）时，判定为需要队长人工确认的冲突 */
export const SITE_MERGE_DISTANCE_M = 50

/** 合并文件（野外分队离线导出的备份）形状 */
export interface MergeFile {
  exportedAt?: string
  specimens?: Specimen[]
  sites?: CollectSite[]
  storages?: Storage[]
  determinations?: Determination[]
}

/** 参与合并的本地台账全集 */
export interface MergeBase {
  sites: CollectSite[]
  specimens: Specimen[]
  determinations: Determination[]
  storages: Storage[]
}

/** 队长对「同代码、坐标差得远」采集地的选择 */
export type SiteResolution = 'local' | 'incoming'

export interface FieldChange {
  field: string
  label: string
  local: unknown
  incoming: unknown
  winner: 'local' | 'incoming'
}

export interface SpecimenPlan {
  /** 标本编号（大写） */
  key: string
  decision: 'add' | 'merge'
  incoming: Specimen
  local?: Specimen
  merged: Specimen
  /** 分类/采集信息采用哪一份（先登记者得） */
  winner: 'local' | 'incoming'
  changes: FieldChange[]
}

export interface SitePlan {
  key: string
  /** add=新增；auto=坐标接近自动并入；conflict=同代码坐标差得远，待队长挑 */
  decision: 'add' | 'auto' | 'conflict'
  incoming: CollectSite
  local?: CollectSite
  distance?: number
  merged: CollectSite
  resolution: SiteResolution
}

export interface DeterminationPlan {
  decision: 'add' | 'skip'
  incoming: Determination
  /** 写入本地的记录（已重挂 specimenId） */
  record: Determination
}

export interface StoragePlan {
  decision: 'add' | 'skip'
  incoming: Storage
  record: Storage
}

export interface MergePlan {
  exportedAt?: string
  sites: SitePlan[]
  specimens: SpecimenPlan[]
  determinations: DeterminationPlan[]
  storages: StoragePlan[]
  /** 导入采集地 id → 最终采集地 id */
  siteIdMap: Record<string, string>
  /** 导入标本 id → 最终标本 id */
  specimenIdMap: Record<string, string>
  warnings: string[]
  stats: {
    sitesAdd: number
    sitesAuto: number
    sitesConflict: number
    specimensAdd: number
    specimensMerge: number
    determinationsAdd: number
    determinationsSkip: number
    storagesAdd: number
    storagesSkip: number
  }
}

/** 分类阶元字段：两份都动过时，先登记的那份为准 */
const TAXONOMY_FIELDS = ['order', 'family', 'genus', 'species', 'tempName'] as const
/** 采集信息字段：同上，先登记的那份为准 */
const COLLECTION_FIELDS = [
  'collectDate',
  'collector',
  'sex',
  'stage',
  'bodyLength',
  'method',
  'quantity',
  'note',
  'siteId'
] as const
/** 鉴定字段：鉴定结论/状态以队里主台账为准，后来这份盖不掉 */
const DETERMINATION_FIELDS = ['status', 'determiner'] as const

const FIELD_LABELS: Record<string, string> = {
  order: '目',
  family: '科',
  genus: '属',
  species: '种',
  tempName: '暂定名',
  collectDate: '采集日期',
  collector: '采集人',
  sex: '性别',
  stage: '虫态',
  bodyLength: '体长',
  method: '采集方式',
  quantity: '数量',
  note: '备注',
  siteId: '采集地',
  status: '鉴定状态',
  determiner: '鉴定人'
}

/** 解析合并文件文本，校验基本形状 */
export function parseMergeFile(text: string): { ok: true; data: MergeFile } | { ok: false; error: string } {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { ok: false, error: '文件不是合法 JSON，请选择本系统导出的备份文件' }
  }
  if (typeof json !== 'object' || json === null) {
    return { ok: false, error: '文件内容不是对象，无法识别' }
  }
  const obj = json as Record<string, unknown>
  const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
  const data: MergeFile = {
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : undefined,
    specimens: asArray(obj.specimens) as Specimen[],
    sites: asArray(obj.sites) as CollectSite[],
    storages: asArray(obj.storages) as Storage[],
    determinations: asArray(obj.determinations) as Determination[]
  }
  return { ok: true, data }
}

/** 取较早登记的一方：缺少 createdAt 的历史记录视为最早；平手算本地（主台账）先 */
function earlierSide(local: Specimen, incoming: Specimen): 'local' | 'incoming' {
  const localAt = local.createdAt ?? ''
  const incomingAt = incoming.createdAt ?? ''
  return incomingAt < localAt ? 'incoming' : 'local'
}

/**
 * 制定合并计划（纯函数，不写库）。
 * @param resolutions 队长对同代码远坐标采集地的选择，key 为采集地代码（大写）
 */
export function planMerge(base: MergeBase, incoming: MergeFile, resolutions: Record<string, SiteResolution> = {}): MergePlan {
  const warnings: string[] = []
  const now = new Date().toISOString()
  const incSites = incoming.sites ?? []
  const incSpecimens = incoming.specimens ?? []
  const incDets = incoming.determinations ?? []
  const incStorages = incoming.storages ?? []

  // ---- 采集地：按代码匹配 ----
  const localSiteByCode = new Map<string, CollectSite>()
  for (const site of base.sites) {
    localSiteByCode.set(site.code.trim().toUpperCase(), site)
  }
  const siteIdMap: Record<string, string> = {}
  const sitePlans: SitePlan[] = []
  for (const inc of incSites) {
    if (!inc || typeof inc.code !== 'string') {
      warnings.push('有一条采集地记录缺少代码，已跳过')
      continue
    }
    const key = inc.code.trim().toUpperCase()
    const local = localSiteByCode.get(key)
    if (!local) {
      sitePlans.push({ key, decision: 'add', incoming: inc, merged: { ...inc }, resolution: 'local' })
      siteIdMap[inc.id] = inc.id
      continue
    }
    const distance = distanceMeters(local.latitude, local.longitude, inc.latitude, inc.longitude)
    if (distance <= SITE_MERGE_DISTANCE_M) {
      // 坐标接近：视为同一采集地，并入本地（主台账为准）
      sitePlans.push({ key, decision: 'auto', incoming: inc, local, distance, merged: { ...local }, resolution: 'local' })
      siteIdMap[inc.id] = local.id
    } else {
      // 同代码但坐标差得远：摆出来让队长挑
      const resolution = resolutions[key] ?? 'local'
      const merged: CollectSite = resolution === 'incoming' ? { ...inc, id: local.id } : { ...local }
      sitePlans.push({ key, decision: 'conflict', incoming: inc, local, distance, merged, resolution })
      siteIdMap[inc.id] = local.id
    }
  }

  // ---- 标本：按编号匹配 ----
  const localSpecimenByCode = new Map<string, Specimen>()
  for (const sp of base.specimens) {
    localSpecimenByCode.set(sp.code.trim().toUpperCase(), sp)
  }
  const specimenIdMap: Record<string, string> = {}
  const specimenPlans: SpecimenPlan[] = []
  const seenCodes = new Set<string>()
  for (const inc of incSpecimens) {
    if (!inc || typeof inc.code !== 'string') {
      warnings.push('有一条标本记录缺少编号，已跳过')
      continue
    }
    const key = inc.code.trim().toUpperCase()
    if (seenCodes.has(key)) {
      warnings.push(`导入文件中标本编号 ${key} 重复，仅保留第一条`)
      continue
    }
    seenCodes.add(key)
    const local = localSpecimenByCode.get(key)
    if (!local) {
      const merged: Specimen = {
        ...inc,
        siteId: siteIdMap[inc.siteId] ?? inc.siteId,
        updatedAt: now
      }
      specimenPlans.push({ key, decision: 'add', incoming: inc, merged, winner: 'incoming', changes: [] })
      specimenIdMap[inc.id] = inc.id
      continue
    }

    const winner = earlierSide(local, inc)
    const changes: FieldChange[] = []
    const merged: Specimen = { ...local }

    // 分类与采集信息：先登记的那份为准
    for (const field of [...TAXONOMY_FIELDS, ...COLLECTION_FIELDS] as const) {
      if (inc[field] !== local[field]) {
        changes.push({ field, label: FIELD_LABELS[field], local: local[field], incoming: inc[field], winner })
      }
      ;(merged as unknown as Record<string, unknown>)[field] = winner === 'incoming' ? inc[field] : local[field]
    }
    // 鉴定状态 / 鉴定人：主台账为准，后来这份盖不掉
    for (const field of DETERMINATION_FIELDS) {
      if (inc[field] !== local[field]) {
        changes.push({ field, label: FIELD_LABELS[field], local: local[field], incoming: inc[field], winner: 'local' })
      }
      ;(merged as unknown as Record<string, unknown>)[field] = local[field]
    }

    merged.siteId = siteIdMap[inc.siteId] ?? local.siteId
    merged.updatedAt = now
    specimenPlans.push({ key, decision: 'merge', incoming: inc, local, merged, winner, changes })
    specimenIdMap[inc.id] = local.id
  }

  // ---- 鉴定记录：按 id 判同一份；新记录重挂 specimenId 后追加 ----
  const localDetIds = new Set(base.determinations.map((det) => det.id))
  const determinationPlans: DeterminationPlan[] = []
  for (const inc of incDets) {
    if (!inc) continue
    if (localDetIds.has(inc.id)) {
      // 同一份鉴定：主台账结论为准，跳过导入
      determinationPlans.push({ decision: 'skip', incoming: inc, record: inc })
    } else {
      const record: Determination = { ...inc, specimenId: specimenIdMap[inc.specimenId] ?? inc.specimenId }
      determinationPlans.push({ decision: 'add', incoming: inc, record })
    }
  }

  // ---- 保藏柜位：按标本判同一份；主台账已入柜则跳过导入，柜位不被盖掉 ----
  const localStorageSpecimenIds = new Set(base.storages.map((stg) => stg.specimenId))
  const storagePlans: StoragePlan[] = []
  for (const inc of incStorages) {
    if (!inc) continue
    const linkedSpecimenId = specimenIdMap[inc.specimenId] ?? inc.specimenId
    if (localStorageSpecimenIds.has(linkedSpecimenId)) {
      storagePlans.push({ decision: 'skip', incoming: inc, record: inc })
    } else {
      const record: Storage = { ...inc, specimenId: linkedSpecimenId }
      storagePlans.push({ decision: 'add', incoming: inc, record })
    }
  }

  return {
    exportedAt: incoming.exportedAt,
    sites: sitePlans,
    specimens: specimenPlans,
    determinations: determinationPlans,
    storages: storagePlans,
    siteIdMap,
    specimenIdMap,
    warnings,
    stats: {
      sitesAdd: sitePlans.filter((p) => p.decision === 'add').length,
      sitesAuto: sitePlans.filter((p) => p.decision === 'auto').length,
      sitesConflict: sitePlans.filter((p) => p.decision === 'conflict').length,
      specimensAdd: specimenPlans.filter((p) => p.decision === 'add').length,
      specimensMerge: specimenPlans.filter((p) => p.decision === 'merge').length,
      determinationsAdd: determinationPlans.filter((p) => p.decision === 'add').length,
      determinationsSkip: determinationPlans.filter((p) => p.decision === 'skip').length,
      storagesAdd: storagePlans.filter((p) => p.decision === 'add').length,
      storagesSkip: storagePlans.filter((p) => p.decision === 'skip').length
    }
  }
}

export interface ApplyResult {
  sites: { ok: boolean; error?: string }
  specimens: { ok: boolean; error?: string }
  determinations: { ok: boolean; error?: string }
  storages: { ok: boolean; error?: string }
}

/**
 * 应用合并计划。每张表一个事务：
 * - 该批失败则整批回滚（事务自动 abort）；
 * - 已提交的表保留，等下次重试（重跑幂等，不会多出条目）。
 */
export async function applyMerge(plan: MergePlan): Promise<ApplyResult> {
  const result: ApplyResult = {
    sites: { ok: true },
    specimens: { ok: true },
    determinations: { ok: true },
    storages: { ok: true }
  }

  try {
    await db.transaction('rw', db.sites, async () => {
      await db.sites.bulkPut(plan.sites.map((p) => p.merged))
    })
  } catch (err) {
    result.sites = { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  try {
    await db.transaction('rw', db.specimens, async () => {
      await db.specimens.bulkPut(plan.specimens.map((p) => p.merged))
    })
  } catch (err) {
    result.specimens = { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  try {
    await db.transaction('rw', db.determinations, async () => {
      await db.determinations.bulkPut(plan.determinations.filter((p) => p.decision === 'add').map((p) => p.record))
    })
  } catch (err) {
    result.determinations = { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  try {
    await db.transaction('rw', db.storages, async () => {
      await db.storages.bulkPut(plan.storages.filter((p) => p.decision === 'add').map((p) => p.record))
    })
  } catch (err) {
    result.storages = { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  return result
}
