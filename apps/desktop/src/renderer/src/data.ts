// 静态 UI 演示数据（后续接入 Supabase / IPC 后替换）

import type { ReactNode } from 'react'

export type ProviderState = 'online' | 'degraded' | 'offline' | 'unbound'

export interface ProviderAccount {
  name: string
  quota: string
  health: 'healthy' | 'expiring' | 'exhausted'
}

export interface Provider {
  id: string
  name: string
  icon: string
  iconComponent?: ReactNode
  unit: string
  remaining: string
  state: ProviderState
  stateLabel: string
  fill: number
  accounts: number
  models: string[]
  accountsDetail: ProviderAccount[]
}

export const PROVIDERS: Provider[] = [
  {
    id: 'doubao',
    name: '豆包',
    icon: '豆',
    unit: '点',
    remaining: '7 / 10',
    state: 'online',
    stateLabel: '正常',
    fill: 70,
    accounts: 2,
    models: ['Seedance 2.0 Mini'],
    accountsDetail: [
      { name: '账号 1（默认）', quota: '4 / 5 点', health: 'healthy' },
      { name: '账号 2', quota: '3 / 5 点', health: 'healthy' }
    ]
  },
  {
    id: 'jimeng',
    name: '即梦',
    icon: '梦',
    unit: '灵感值',
    remaining: '640 / 800',
    state: 'online',
    stateLabel: '正常',
    fill: 80,
    accounts: 1,
    models: ['视频 S2.0', '视频 S2.0 Pro'],
    accountsDetail: [{ name: '账号 1（默认）', quota: '640 / 800 灵感值', health: 'healthy' }]
  },
  {
    id: 'qwen',
    name: '通义万相',
    icon: '问',
    unit: '额度',
    remaining: '6 / 10',
    state: 'online',
    stateLabel: '正常',
    fill: 60,
    accounts: 1,
    models: ['万相 2.7', '万相 2.6', 'HappyHorse 1.0 Beta'],
    accountsDetail: [{ name: '账号 1（默认）', quota: '6 / 10 额度', health: 'healthy' }]
  },
  {
    id: 'yuanbao',
    name: '元宝混元',
    icon: '元',
    unit: '个',
    remaining: '4 / 5',
    state: 'degraded',
    stateLabel: '将过期',
    fill: 80,
    accounts: 1,
    models: ['混元（固定）'],
    accountsDetail: [{ name: '账号 1（默认）', quota: '4 / 5 个', health: 'expiring' }]
  },
  {
    id: 'kling',
    name: '可灵',
    icon: '灵',
    unit: '积分',
    remaining: '186 / 216',
    state: 'online',
    stateLabel: '正常',
    fill: 86,
    accounts: 1,
    models: ['可灵-标准', '可灵-大师'],
    accountsDetail: [{ name: '账号 1（默认）', quota: '186 / 216 积分', health: 'healthy' }]
  },
  {
    id: 'hailuo',
    name: '海螺',
    icon: '螺',
    unit: '次',
    remaining: '1 / 3',
    state: 'online',
    stateLabel: '正常',
    fill: 33,
    accounts: 1,
    models: ['海螺-标准'],
    accountsDetail: [{ name: '账号 1（默认）', quota: '1 / 3 次', health: 'healthy' }]
  },
  {
    id: 'mathmind',
    name: 'MathMind',
    icon: 'M',
    unit: '次',
    remaining: '8 / 10',
    state: 'online',
    stateLabel: '正常',
    fill: 80,
    accounts: 1,
    models: ['mathmind-v1', 'mathmind-v2'],
    accountsDetail: [{ name: '账号 1（默认）', quota: '8 / 10 次', health: 'healthy' }]
  }
]

export interface HistoryRow {
  provider: string
  status: '成功' | '排队' | '失败'
  prompt: string
  mode: string
  cost: string
  quality: string
  duration?: string
  time?: string
}

export const HISTORY_ROWS: HistoryRow[] = [
  { provider: '豆包', status: '成功', prompt: '一只橘猫在阳光下打盹，微风轻拂窗帘', mode: '文生视频', cost: '1 点', quality: '4.5', duration: '5s', time: '2 分钟前' },
  { provider: '即梦', status: '成功', prompt: '赛博朋克风格的城市夜景，霓虹灯闪烁', mode: '文生视频', cost: '80 灵感值', quality: '4.2', duration: '10s', time: '18 分钟前' },
  { provider: '可灵', status: '排队', prompt: '古风女子在樱花树下抚琴，花瓣飘落', mode: '文生视频', cost: '10 积分', quality: '-', time: '35 分钟前' },
  { provider: 'MathMind', status: '成功', prompt: '机器人行走在火星表面，背景是巨大的蓝色地球', mode: '图生视频', cost: '1 次', quality: '3.8', duration: '5s', time: '1 小时前' },
  { provider: '海螺', status: '失败', prompt: '海浪拍打礁石，夕阳西下的慢镜头', mode: '文生视频', cost: '1 次', quality: '-', time: '2 小时前' },
  { provider: '元宝混元', status: '成功', prompt: '未来城市飞行汽车穿梭于摩天大楼之间', mode: '文生视频', cost: '1 次', quality: '4.0' },
  { provider: '豆包', status: '成功', prompt: '水墨画风格的山水动画，云雾缭绕', mode: '文生视频', cost: '2 点', quality: '4.7' },
  { provider: '即梦', status: '成功', prompt: '热带雨林中的瀑布，阳光透过树叶洒落', mode: '图生视频', cost: '80 灵感值', quality: '4.3' },
  { provider: '可灵', status: '成功', prompt: '冰川崩塌的震撼瞬间，慢动作回放', mode: '文生视频', cost: '5 积分', quality: '3.9' },
  { provider: 'MathMind', status: '成功', prompt: '微观世界的细胞分裂过程，科学可视化', mode: '文生视频', cost: '1 次', quality: '4.1' }
]

export interface TeamMember {
  name: string
  role: string
  used: string
  limit: string
  own: string
  state: '正常' | '未激活'
}

export const TEAM = {
  header: '3 人团队 · 共享 128 次/日',
  seats: '2/3 席位',
  members: [
    { name: '我 (Admin)', role: '管理员', used: '12 次', limit: '无限制', own: '豆包x2, 即梦x1', state: '正常' as const },
    { name: '小王', role: '成员', used: '8 次', limit: '30 次', own: '元宝x1', state: '正常' as const },
    { name: '小李', role: '成员', used: '0 次', limit: '30 次', own: '无', state: '未激活' as const }
  ],
  config: [
    { label: '当前套餐', value: '团队免费' },
    { label: '席位上限', value: '3 人' },
    { label: '成员日上限', value: '30 次/人' },
    { label: '公共额度账号', value: '6 个账号' }
  ]
}
