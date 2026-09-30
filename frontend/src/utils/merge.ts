import type {
  DeterminationPlan,
  FieldResolution,
  MergePlan,
  MergeStats,
  SiteChoice,
  SitePlan,
  SpecimenPlan,
  SquadPacket,
  StoragePlan
} from '@/types/merge'
import type { CollectSite } from '@/types/site'
import type { Determination } from '@/types/determination'
import type { Specimen } from '@/types/specimen'
import type { Storage } from '@/types/storage'
import { distanceMeters } from '@/types/site'
import { PACKET_KIND, PACKET_VERSION, SITE_FAR_THRESHOLD_METERS } from '@/types/merge'
import { db } from '@/hooks/usePersistentStore'
import { encodeSlot } from '@/utils/codec'

/** 分类与采集信息字段：同编号两边都动过时，认先登记的一份 */
export const TAXON_COLLECT_FIELDS: { key: keyof Specimen; label: string }[] = [
  { key: 'order', label: '目' },
  { key: 'family', label: '科' },
  { key: 'genus', label: '属' },
  { key: 'species', label: '种' },
  { key: 'tempName', label: '暂定名' },
  { key: 'collectDate', label: '采集日期' },
  { key: 'collector', label: '采集人' },
  { key: 'sex', label: '性别' },
  { key: 'stage', label: '虫态' },
  { key: 'bodyLength', label: '体长mm' },
  { key: 'method', label: '采集方式' },
  { key: 'quantity', label: '数量' },
  { key: 'note', label: '备注' }
]

/** 鉴定状态 / 鉴定人属于鉴定结论范畴，主台账已有值时不被分队那份盖掉 */
export const DETENTION_PROTECTED_FIELDS: { key: keyof Specimen; label: string }[] = [
  { key: 'status', label: '鉴定状态' },
  { key: 'determiner', label: '鉴定人' }
]

/** 缺失登记时间时的兜底值：视为最晚登记，让有时间戳的一方获胜 */
const FALLBACK_REGISTERED_AT = '9999-12-31T23:59:59.999Z'

function registeredAtOf(specimen: Specimen | undefined): string {
  const value = specimen?.registeredAt
  return value && !Number.isNaN(Date.parse(value)) ? value : FALLBACK_REGISTERED_AT
}

/** 分类与采集信息认先登记的一份；并列时主台账优先 */
export function earlierWins(master: Specimen, squad: Specimen): 'master' | 'squad' {
  const masterTime = Date.parse(registeredAtOf(master))
  const squadTime = Date.parse(registeredAtOf(squad))
  if (squadTime < masterTime) return 'squad'
  return 'master'
}

/** 简易稳定哈希（FNV-1a 32 位），用于生成幂等的确定性 ID */
function hash32(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36).padStart(7, '0')
}

function idSafe(text: string): string {
  return text.replace(/[^A-Za-z0-9]+/g, '_')
}

function packetSalt(packet: SquadPacket): string {
  return hash32(`${idSafe(packet.squadName)}|${packet.exportedAt}`)
}

/** 分队独有的标本编号 → 主台账内确定性新 ID（同一份数据包重复并账不会多出条目） */
export function mergedSpecimenId(packet: SquadPacket, code: string): string {
  return `sp_m_${packetSalt(packet)}_${idSafe(code.toUpperCase())}`
}

export function mergedSiteId(packet: SquadPacket, code: string): string {
  return `site_m_${packetSalt(packet)}_${idSafe(code.toUpperCase())}`
}

function mergedDeterminationId(packet: SquadPacket, record: Determination): string {
  return `det_m_${packetSalt(packet)}_${hash32(determinationNaturalKey(record))}`
}

export function mergedStorageId(packet: SquadPacket, code: string): string {
  return `stg_m_${packetSalt(packet)}_${idSafe(code.toUpperCase())}`
}

/** 鉴定记录业务键：同一标本、同一鉴定人/日期/结论视为同一条 */
export function determinationNaturalKey(record: Determination): string {
  return [record.determiner ?? '', record.date ?? '', record.conclusion ?? '']
    .map((part) => part.trim())
    .join('§')
}

function slotKey(storage: Storage): string {
  return encodeSlot(storage.cabinet, storage.drawer, storage.box, storage.slot)
}

/** 解析并校验分队数据包 */
export function parseSquadPacket(raw: string): SquadPacket {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error('文件不是合法的 JSON，请选择分队导出的数据包')
  }
  if (typeof data !== 'object' || data === null) throw new Error('数据包结构不正确')
  const packet = data as Partial<SquadPacket>
  if (packet.kind !== PACKET_KIND) {
    throw new Error(`数据包类型标识不正确（应为 ${PACKET_KIND}），请确认文件来自分队「台账并账」页的导出`)
  }
  if (packet.packetVersion !== PACKET_VERSION) {
    throw new Error(`数据包版本 ${String(packet.packetVersion)} 与当前程序（v${PACKET_VERSION}）不兼容`)
  }
  if (!Array.isArray(packet.sites) || !Array.isArray(packet.specimens) || !Array.isArray(packet.determinations) || !Array.isArray(packet.storages)) {
    throw new Error('数据包缺少 sites / specimens / determinations / storages 四张表')
  }
  const squadName = typeof packet.squadName === 'string' && packet.squadName.trim() ? packet.squadName.trim() : '未命名分队'
  const exportedAt = typeof packet.exportedAt === 'string' && packet.exportedAt ? packet.exportedAt : new Date(0).toISOString()

  const duplicateCodes = (list: { code?: string }[]): string[] => {
    const seen = new Set<string>()
    const dup = new Set<string>()
    list.forEach((item) => {
      const code = (item.code ?? '').trim().toUpperCase()
      if (!code) return
      if (seen.has(code)) dup.add(code)
      seen.add(code)
    })
    return [...dup]
  }

  for (const table of [
    { name: '标本', list: packet.specimens as { code?: string }[] },
    { name: '采集地', list: packet.sites as { code?: string }[] }
  ]) {
    const dup = duplicateCodes(table.list)
    if (dup.length > 0) throw new Error(`数据包内${table.name}编号重复：${dup.join('、')}，请先在分队台账内处理`)
  }
  for (const specimen of packet.specimens as Specimen[]) {
    if (!specimen.id || !specimen.code) throw new Error('数据包内存在缺少编号的标本记录')
  }

  return {
    kind: PACKET_KIND,
    packetVersion: PACKET_VERSION,
    squadName,
    exportedAt,
    sites: packet.sites as CollectSite[],
    specimens: packet.specimens as Specimen[],
    determinations: packet.determinations as Determination[],
    storages: packet.storages as Storage[]
  }
}

function byCode<T extends { code: string }>(rows: T[]): Map<string, T> {
  const map = new Map<string, T>()
  rows.forEach((row) => map.set(row.code.trim().toUpperCase(), row))
  return map
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  return a === undefined || a === null || a === '' ? b === undefined || b === null || b === '' : false
}

/**
 * 读阶段预检：把分队数据包与主台账逐表比对，产出并账计划。
 * 不写任何数据；距离过远的采集地先挂起，等队长裁决后重新构建。
 */
export function buildMergePlan(
  packet: SquadPacket,
  master: { sites: CollectSite[]; specimens: Specimen[]; determinations: Determination[]; storages: Storage[] },
  siteChoices: Record<string, SiteChoice> = {}
): MergePlan {
  const masterSites = byCode(master.sites)
  const masterSpecimens = byCode(master.specimens)

  // ---- 采集地 ----
  const sitePlans: SitePlan[] = packet.sites.map((squad) => {
    const code = squad.code.trim().toUpperCase()
    const masterSite = masterSites.get(code) ?? null
    if (!masterSite) {
      return { code, kind: 'new', master: null, squad, distance: 0, choice: null }
    }
    const distance = distanceMeters(
      masterSite.latitude,
      masterSite.longitude,
      squad.latitude,
      squad.longitude
    )
    if (distance > SITE_FAR_THRESHOLD_METERS) {
      return { code, kind: 'far', master: masterSite, squad, distance, choice: siteChoices[code] ?? null }
    }
    return { code, kind: 'same', master: masterSite, squad, distance, choice: null }
  })

  /** code → 并账后主台账采集地 ID */
  const resolveSiteId = new Map<string, string>()
  sitePlans.forEach((plan) => {
    if (plan.master) {
      resolveSiteId.set(plan.code, plan.master.id)
    } else {
      resolveSiteId.set(plan.code, mergedSiteId(packet, plan.code))
    }
  })

  /** 分队原始 siteId → 并账后采集地 ID */
  const packetSiteIdMap = new Map<string, string>()
  packet.sites.forEach((site) => {
    packetSiteIdMap.set(site.id, resolveSiteId.get(site.code.trim().toUpperCase()) ?? site.id)
  })

  const remapSiteId = (squad: Specimen): string => {
    const direct = packetSiteIdMap.get(squad.siteId)
    if (direct) return direct
    const prefix = squad.code.split('-')[0]?.trim().toUpperCase()
    const byPrefix = prefix ? resolveSiteId.get(prefix) : undefined
    if (byPrefix) return byPrefix
    throw new Error(`标本 ${squad.code} 引用的采集地不在数据包内，无法并账`)
  }

  // ---- 标本 ----
  const specimenPlans: SpecimenPlan[] = packet.specimens.map((squadRaw) => {
    const code = squadRaw.code.trim().toUpperCase()
    const squad: Specimen = { ...squadRaw, code }
    const master = masterSpecimens.get(code) ?? null

    if (!master) {
      const output: Specimen = {
        ...squad,
        id: mergedSpecimenId(packet, code),
        siteId: remapSiteId(squad),
        registeredAt: registeredAtOf(squad) === FALLBACK_REGISTERED_AT ? packet.exportedAt : squad.registeredAt
      }
      return { code, kind: 'new', master: null, squad, fields: [], taxonWinner: null, output }
    }

    const winner = earlierWins(master, squad)
    const fields: FieldResolution[] = TAXON_COLLECT_FIELDS.map(({ key, label }) => {
      const masterValue = master[key]
      const squadValue = squad[key]
      const fieldWinner: 'master' | 'squad' = winner
      return {
        key,
        label,
        master: masterValue,
        squad: squadValue,
        winner: fieldWinner,
        changed: !sameValue(masterValue, squadValue)
      }
    })

    const output: Specimen = { ...master }
    TAXON_COLLECT_FIELDS.forEach(({ key }) => {
      ;(output[key] as unknown) = winner === 'squad' ? squad[key] : master[key]
    })
    // siteId 跟随并账后的采集地；id / registeredAt / status / determiner 保持主台账
    output.siteId = remapSiteId(squad)

    return { code, kind: 'existing', master, squad, fields, taxonWinner: winner, output }
  })

  /** 分队标本原始 ID → 编号 */
  const packetSpecimenCodeById = new Map<string, string>()
  packet.specimens.forEach((specimen) => {
    packetSpecimenCodeById.set(specimen.id, specimen.code.trim().toUpperCase())
  })

  const codeOfSquadSpecimenId = (specimenId: string): string => {
    const code = packetSpecimenCodeById.get(specimenId)
    if (code) return code
    // 兼容分队直接引用主台账标本 ID 的情况
    const masterSpecimen = master.specimens.find((item) => item.id === specimenId)
    if (masterSpecimen) return masterSpecimen.code.trim().toUpperCase()
    throw new Error(`鉴定/保藏记录引用的标本不在数据包内（specimenId=${specimenId}）`)
  }

  // ---- 鉴定记录：主台账已有的结论绝不覆盖，只按业务键补记缺失 ----
  const masterDetCountByCode = new Map<string, number>()
  master.determinations.forEach((record) => {
    const specimen = master.specimens.find((item) => item.id === record.specimenId)
    if (specimen) {
      const code = specimen.code.trim().toUpperCase()
      masterDetCountByCode.set(code, (masterDetCountByCode.get(code) ?? 0) + 1)
    }
  })
  const masterDetKeys = new Set(
    master.determinations.map((record) => {
      const specimen = master.specimens.find((item) => item.id === record.specimenId)
      return specimen ? `${specimen.code.trim().toUpperCase()}§${determinationNaturalKey(record)}` : ''
    })
  )

  const determinationPlans: DeterminationPlan[] = packet.determinations.map((record) => {
    const code = codeOfSquadSpecimenId(record.specimenId)
    const specimenPlan = specimenPlans.find((plan) => plan.code === code)
    if (!specimenPlan) {
      throw new Error(`鉴定记录引用的标本不在数据包内（specimenId=${record.specimenId}）`)
    }
    const output: Determination = {
      ...record,
      id: mergedDeterminationId(packet, record),
      specimenId: specimenPlan.output.id
    }
    if (specimenPlan.kind === 'new') {
      return { specimenCode: code, squad: record, action: 'add-to-new-specimen', output }
    }
    // 已存在标本：主台账已有任意鉴定结论则分队结论一律不并入（不盖掉，也不稀释历史）
    if ((masterDetCountByCode.get(code) ?? 0) > 0) {
      return { specimenCode: code, squad: record, action: 'skip-master-determined', output: null }
    }
    const key = `${code}§${determinationNaturalKey(record)}`
    if (masterDetKeys.has(key)) {
      return { specimenCode: code, squad: record, action: 'skip-duplicate', output: null }
    }
    return { specimenCode: code, squad: record, action: 'append', output }
  })

  // ---- 保藏柜位：主台账已有柜位的标本不被盖掉；柜位被别的标本占用则跳过并上报 ----
  const masterStorageBySpecimenCode = new Map<string, Storage>()
  master.storages.forEach((storage) => {
    const specimen = master.specimens.find((item) => item.id === storage.specimenId)
    if (specimen) masterStorageBySpecimenCode.set(specimen.code.trim().toUpperCase(), storage)
  })
  const occupiedSlots = new Map<string, string>()
  master.storages.forEach((storage) => {
    occupiedSlots.set(slotKey(storage), storage.specimenId)
  })

  const storagePlans: StoragePlan[] = packet.storages.map((storage) => {
    const code = codeOfSquadSpecimenId(storage.specimenId)
    const specimenPlan = specimenPlans.find((plan) => plan.code === code)
    if (!specimenPlan) {
      throw new Error(`保藏记录引用的标本不在数据包内（specimenId=${storage.specimenId}）`)
    }
    const output: Storage = {
      ...storage,
      id: mergedStorageId(packet, code),
      specimenId: specimenPlan.output.id
    }
    if (specimenPlan.kind === 'new') {
      const occupant = occupiedSlots.get(slotKey(storage))
      if (occupant) {
        const occupantSpecimen = master.specimens.find((item) => item.id === occupant)
        return {
          specimenCode: code,
          squad: storage,
          action: 'skip-slot-conflict',
          conflict: `柜位 ${slotKey(storage)} 已被 ${occupantSpecimen?.code ?? occupant} 占用`,
          output: null
        }
      }
      return { specimenCode: code, squad: storage, action: 'add-to-new-specimen', output, conflict: null }
    }
    if (masterStorageBySpecimenCode.has(code)) {
      const existing = masterStorageBySpecimenCode.get(code) as Storage
      return {
        specimenCode: code,
        squad: storage,
        action: 'skip-occupied-master',
        conflict: `主台账已入柜 ${slotKey(existing)}，不覆盖`,
        output: null
      }
    }
    const occupant = occupiedSlots.get(slotKey(storage))
    if (occupant) {
      const occupantSpecimen = master.specimens.find((item) => item.id === occupant)
      return {
        specimenCode: code,
        squad: storage,
        action: 'skip-slot-conflict',
        conflict: `柜位 ${slotKey(storage)} 已被 ${occupantSpecimen?.code ?? occupant} 占用`,
        output: null
      }
    }
    return { specimenCode: code, squad: storage, action: 'fill-empty', output, conflict: null }
  })

  return { packet, sites: sitePlans, specimens: specimenPlans, determinations: determinationPlans, storages: storagePlans }
}

/** 是否还有距离过远、等队长裁决的采集地 */
export function unresolvedSiteChoices(plan: MergePlan): SitePlan[] {
  return plan.sites.filter((site) => site.kind === 'far' && site.choice !== 'master' && site.choice !== 'squad')
}

export interface PlanSummary {
  newSpecimens: number
  existingSpecimens: number
  changedSpecimens: number
  newSites: number
  farSites: number
  determinationsAdded: number
  determinationsSkipped: number
  storagesAdded: number
  storagesSkipped: number
}

export function summarizePlan(plan: MergePlan): PlanSummary {
  return {
    newSpecimens: plan.specimens.filter((item) => item.kind === 'new').length,
    existingSpecimens: plan.specimens.filter((item) => item.kind === 'existing').length,
    changedSpecimens: plan.specimens.filter(
      (item) => item.kind === 'existing' && item.fields.some((field) => field.changed)
    ).length,
    newSites: plan.sites.filter((item) => item.kind === 'new').length,
    farSites: unresolvedSiteChoices(plan).length,
    determinationsAdded: plan.determinations.filter((item) => item.output !== null).length,
    determinationsSkipped: plan.determinations.filter((item) => item.output === null).length,
    storagesAdded: plan.storages.filter((item) => item.output !== null).length,
    storagesSkipped: plan.storages.filter((item) => item.output === null).length
  }
}

/**
 * 写阶段：在单个 Dexie 事务内提交四表变更。
 * 事务内重新校验柜位占用，任何一步失败整批回滚（已提交的其他批次不受影响）。
 */
export async function commitMergePlan(plan: MergePlan): Promise<MergeStats> {
  const pending = unresolvedSiteChoices(plan)
  if (pending.length > 0) {
    throw new Error(`采集地 ${pending.map((item) => item.code).join('、')} 坐标尚未裁决，请先由队长选择后再提交`)
  }

  const stats: MergeStats = {
    squadName: plan.packet.squadName,
    sitesInserted: 0,
    sitesUpdated: 0,
    specimensInserted: 0,
    specimensUpdated: 0,
    determinationsAdded: 0,
    storagesAdded: 0,
    storageSkipped: []
  }

  await db.transaction('rw', db.sites, db.specimens, db.determinations, db.storages, async () => {
    // 采集地
    for (const site of plan.sites) {
      if (site.kind === 'new') {
        await db.sites.put({ ...site.squad, id: mergedSiteId(plan.packet, site.code) })
        stats.sitesInserted += 1
      } else if (site.choice === 'squad') {
        // 队长选用分队坐标与描述：覆盖主台账记录，但保留主台账 ID 与编号
        await db.sites.put({ ...site.squad, id: (site.master as CollectSite).id, code: site.code })
        stats.sitesUpdated += 1
      }
      // same 或 choice=master：主台账原样保留
    }

    // 标本
    for (const specimen of plan.specimens) {
      if (specimen.kind === 'new') {
        await db.specimens.put(specimen.output)
        stats.specimensInserted += 1
      } else {
        // 已存在标本：只落分类/采集字段与采集地归属；鉴定状态/鉴定人以库里现值为准，不被旧快照盖掉
        const current = await db.specimens.get(specimen.output.id)
        if (current) {
          const next: Specimen = { ...current, siteId: specimen.output.siteId }
          specimen.fields.forEach((field) => {
            if (field.winner === 'squad') {
              ;(next[field.key] as unknown) = specimen.squad[field.key]
            }
          })
          if (JSON.stringify(current) !== JSON.stringify(next)) {
            await db.specimens.put(next)
            stats.specimensUpdated += 1
          }
        }
      }
    }

    // 鉴定记录：业务键已去重，确定性 ID 保证重复并账不多条目
    const existingDetIds = new Set(await db.determinations.toCollection().primaryKeys())
    for (const det of plan.determinations) {
      if (det.output && !existingDetIds.has(det.output.id)) {
        await db.determinations.put(det.output)
        stats.determinationsAdded += 1
      }
    }

    // 保藏柜位：事务内复查占用，冲突直接抛错让整批回滚
    const existingStorageIds = new Set(await db.storages.toCollection().primaryKeys())
    const occupied = new Map<string, string>()
    const allStorages = await db.storages.toArray()
    allStorages.forEach((storage) => occupied.set(slotKey(storage), storage.specimenId))
    for (const storage of plan.storages) {
      if (!storage.output) {
        stats.storageSkipped.push(storage.specimenCode)
        continue
      }
      const key = slotKey(storage.output)
      const occupant = occupied.get(key)
      if (occupant && occupant !== storage.output.specimenId) {
        throw new Error(`提交时发现柜位 ${key} 已被其他标本占用，本批整体回滚，请重新预检`)
      }
      if (!existingStorageIds.has(storage.output.id) && !occupant) {
        await db.storages.put(storage.output)
        occupied.set(key, storage.output.specimenId)
        stats.storagesAdded += 1
      }
    }
  })

  return stats
}
