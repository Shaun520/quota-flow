// 静态 UI 演示数据（Providers / Team 仍在使用，History 已接入真实数据）

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
    models: ['混元'],
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
  }
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
