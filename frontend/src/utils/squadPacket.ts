import type { CollectSite } from '@/types/site'
import type { Determination } from '@/types/determination'
import type { Specimen } from '@/types/specimen'
import type { Storage } from '@/types/storage'
import type { SquadPacket } from '@/types/merge'
import { PACKET_KIND, PACKET_VERSION } from '@/types/merge'
import { downloadJson } from '@/utils/export'

/** 把本机当前台账打成分队数据包（全量四表） */
export function buildSquadPacket(
  squadName: string,
  rows: { sites: CollectSite[]; specimens: Specimen[]; determinations: Determination[]; storages: Storage[] }
): SquadPacket {
  return {
    kind: PACKET_KIND,
    packetVersion: PACKET_VERSION,
    squadName: squadName.trim() || '未命名分队',
    exportedAt: new Date().toISOString(),
    sites: structuredCloneSafe(rows.sites),
    specimens: structuredCloneSafe(rows.specimens),
    determinations: structuredCloneSafe(rows.determinations),
    storages: structuredCloneSafe(rows.storages)
  }
}

function structuredCloneSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 导出分队数据包 JSON 文件 */
export function exportSquadPacket(squadName: string, rows: {
  sites: CollectSite[]
  specimens: Specimen[]
  determinations: Determination[]
  storages: Storage[]
}): SquadPacket {
  const packet = buildSquadPacket(squadName, rows)
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')
  downloadJson(`分队台账-${packet.squadName}-${stamp}.json`, packet)
  return packet
}

/**
 * 构造一份演示数据包，覆盖并账的各种情形（不落库，仅供队长页下载试用）：
 * - QLB 同代码坐标偏差很大 → 队长裁决
 * - 主台账已有标本 QLB-2026-0001，分队登记更早、分类与采集信息不同
 * - 主台账已有鉴定/柜位，分队同标本的鉴定与新柜位都不应覆盖
 * - 新采集地 HGS 与新标本 HGS-2026-0001（含鉴定与入柜）
 * - 新标本 HGS-2026-0002 的柜位故意撞上主台账 C01-D1-B02-S03 → 跳过并提示
 */
export function buildDemoPacket(): SquadPacket {
  const today = new Date().toISOString().slice(0, 10)
  const squadName = '甲组分队（演示）'

  const sites: CollectSite[] = [
    {
      id: 'demo_site_qlb',
      code: 'QLB',
      name: '青龙背斜西坡阔叶林',
      region: '黔南州 · 平塘县',
      longitude: 107.2301,
      latitude: 25.8407,
      altitude: 1012,
      habitat: '阔叶林',
      microHabitat: '西坡沟谷，枯竹与倒木',
      microClimate: '午后阵雨，湿度高',
      dateStart: today,
      dateEnd: today
    },
    {
      id: 'demo_site_hgs',
      code: 'HGS',
      name: '横冈山针阔混交林',
      region: '黔南州 · 惠水县',
      longitude: 106.8012,
      latitude: 26.1604,
      altitude: 1140,
      habitat: '针阔混交林',
      microHabitat: '华山松与栎树混交，树皮缝隙',
      microClimate: '清晨有露，风速 2 级',
      dateStart: today,
      dateEnd: today
    }
  ]

  const specimens: Specimen[] = [
    {
      id: 'demo_sp_qlb_1',
      code: 'QLB-2026-0001',
      registeredAt: `${today}T06:40:00.000Z`,
      order: '鞘翅目',
      family: '步甲科',
      genus: 'Cychrus',
      species: 'sp.',
      tempName: '长颚食蜗步甲',
      collectDate: today,
      collector: '韩涧',
      sex: '雌',
      stage: '成虫',
      bodyLength: 31.0,
      method: '巴氏罐诱',
      quantity: 1,
      status: '初鉴',
      determiner: '韩涧',
      siteId: 'demo_site_qlb',
      note: '沟谷罐诱，头管特长（分队早班登记，与主台账分类/采集信息不同）'
    },
    {
      id: 'demo_sp_hgs_1',
      code: 'HGS-2026-0001',
      registeredAt: `${today}T07:15:00.000Z`,
      order: '膜翅目',
      family: '蚁科',
      genus: 'Camponotus',
      species: 'sp.',
      tempName: '黑弓背蚁',
      collectDate: today,
      collector: '韩涧',
      sex: '未知',
      stage: '成虫',
      bodyLength: 9.8,
      method: '徒手',
      quantity: 6,
      status: '已鉴定',
      determiner: '韩涧',
      siteId: 'demo_site_hgs',
      note: '松干树皮下整巢采集，含工蚁与兵蚁'
    },
    {
      id: 'demo_sp_hgs_2',
      code: 'HGS-2026-0002',
      registeredAt: `${today}T07:26:00.000Z`,
      order: '鞘翅目',
      family: '小蠹科',
      genus: '',
      species: '',
      tempName: '松干小蠹',
      collectDate: today,
      collector: '韩涧',
      sex: '未知',
      stage: '幼虫',
      bodyLength: 4.2,
      method: '徒手',
      quantity: 20,
      status: '待鉴定',
      determiner: '',
      siteId: 'demo_site_hgs',
      note: '坑道内幼虫，建议浸液（柜位与主台账已有柜位冲突，应被跳过）'
    }
  ]

  const determinations: Determination[] = [
    {
      id: 'demo_det_qlb_1',
      specimenId: 'demo_sp_qlb_1',
      determiner: '韩涧',
      date: today,
      conclusion: 'Cychrus sp.',
      reference: '野外面包虫检索表（草签）',
      confidence: '低',
      needReview: true
    },
    {
      id: 'demo_det_hgs_1',
      specimenId: 'demo_sp_hgs_1',
      determiner: '韩涧',
      date: today,
      conclusion: 'Camponotus japonicus',
      reference: '《中国蚂蚁》野外对照',
      confidence: '中',
      needReview: false
    }
  ]

  const storages: Storage[] = [
    {
      id: 'demo_stg_qlb_1',
      specimenId: 'demo_sp_qlb_1',
      method: '针插',
      cabinet: 'C02',
      drawer: 1,
      box: 1,
      slot: 1,
      storedDate: today,
      handler: '韩涧'
    },
    {
      id: 'demo_stg_hgs_1',
      specimenId: 'demo_sp_hgs_1',
      method: '针插',
      cabinet: 'C02',
      drawer: 1,
      box: 1,
      slot: 2,
      storedDate: today,
      handler: '韩涧'
    },
    {
      id: 'demo_stg_hgs_2',
      specimenId: 'demo_sp_hgs_2',
      method: '浸液',
      cabinet: 'C01',
      drawer: 1,
      box: 2,
      slot: 3,
      storedDate: today,
      handler: '韩涧'
    }
  ]

  return {
    kind: PACKET_KIND,
    packetVersion: PACKET_VERSION,
    squadName,
    exportedAt: new Date().toISOString(),
    sites,
    specimens,
    determinations,
    storages
  }
}
