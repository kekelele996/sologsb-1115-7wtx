import type { CollectSite } from './site'
import type { Determination } from './determination'
import type { Specimen } from './specimen'
import type { Storage } from './storage'

/** 分队数据包类型标识与当前格式版本 */
export const PACKET_KIND = 'gbinsectlog-squad-packet'
export const PACKET_VERSION = 1

/** 采集地代码相同但坐标相差超过该距离（米）时，需队长人工裁决 */
export const SITE_FAR_THRESHOLD_METERS = 50

/** 分队离线台账数据包：四表全量快照 */
export interface SquadPacket {
  kind: typeof PACKET_KIND
  packetVersion: number
  squadName: string
  exportedAt: string
  sites: CollectSite[]
  specimens: Specimen[]
  determinations: Determination[]
  storages: Storage[]
}

export type SiteChoice = 'master' | 'squad'

/** 采集地并账计划 */
export interface SitePlan {
  code: string
  kind: 'new' | 'same' | 'far'
  master: CollectSite | null
  squad: CollectSite
  /** kind=far 时的坐标距离（米） */
  distance: number
  /** 队长裁决：master 保留主台账坐标与描述，squad 用分队那份覆盖 */
  choice: SiteChoice | null
}

/** 标本单字段的并账结果 */
export interface FieldResolution {
  key: keyof Specimen
  label: string
  master: unknown
  squad: unknown
  winner: 'master' | 'squad'
  changed: boolean
}

/** 标本并账计划 */
export interface SpecimenPlan {
  code: string
  kind: 'new' | 'existing'
  master: Specimen | null
  squad: Specimen
  /** 分类与采集信息各字段的取数结果（鉴定状态/鉴定人不在其内，永不覆盖） */
  fields: FieldResolution[]
  /** 本记录分类与采集信息的取数方 */
  taxonWinner: 'master' | 'squad' | null
  /** 并账后最终落库的标本 */
  output: Specimen
}

/** 鉴定记录并账计划 */
export interface DeterminationPlan {
  specimenCode: string
  squad: Determination
  /** add-to-new-specimen 随新标本并入；append 主台账无结论时补入；skip-* 主台账已有结论或同业务键，不并入 */
  action: 'add-to-new-specimen' | 'append' | 'skip-duplicate' | 'skip-master-determined'
  /** append / add-to-new-specimen 时的落库记录（已重映射 specimenId） */
  output: Determination | null
}

/** 保藏柜位并账计划 */
export interface StoragePlan {
  specimenCode: string
  squad: Storage
  action: 'add-to-new-specimen' | 'fill-empty' | 'skip-occupied-master' | 'skip-slot-conflict'
  conflict: string | null
  output: Storage | null
}

/** 并账预检计划（读阶段产出，尚未写库） */
export interface MergePlan {
  packet: SquadPacket
  sites: SitePlan[]
  specimens: SpecimenPlan[]
  determinations: DeterminationPlan[]
  storages: StoragePlan[]
}

/** 提交并账后的计数 */
export interface MergeStats {
  squadName: string
  sitesInserted: number
  sitesUpdated: number
  specimensInserted: number
  specimensUpdated: number
  determinationsAdded: number
  storagesAdded: number
  /** 柜位被占用而跳过的标本编号 */
  storageSkipped: string[]
}
