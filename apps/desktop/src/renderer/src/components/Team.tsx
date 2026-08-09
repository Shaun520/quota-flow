import { TEAM } from '../data'

export default function Team() {
  return (
    <>
      <div className="page-header">
        <div className="title-group">
          <div>
            <h1>团队额度池</h1>
            <div className="divider" />
          </div>
          <p>{TEAM.header}</p>
        </div>
      </div>

      <div className="team-grid">
        <div className="team-panel">
          <div className="panel-header">
            <h2>成员列表</h2>
            <span className="panel-meta">{TEAM.seats}</span>
          </div>
          <div className="history-table-wrap" style={{ flex: 1, minHeight: 0 }}>
            <div className="table-scroll">
              <table className="team-table">
                <thead>
                  <tr>
                    <th>成员</th>
                    <th>角色</th>
                    <th>今日消耗</th>
                    <th>日上限</th>
                    <th>自带额度</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {TEAM.members.map((m) => (
                    <tr key={m.name}>
                      <td>
                        <strong>{m.name}</strong>
                      </td>
                      <td>{m.role}</td>
                      <td>{m.used}</td>
                      <td>{m.limit}</td>
                      <td>{m.own}</td>
                      <td>
                        <span className={m.state === '正常' ? 'badge badge-success' : 'badge badge-pending'}>
                          {m.state}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="team-panel">
          <div className="panel-header">
            <h2>团队配置</h2>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {TEAM.config.map((c) => (
              <div className="config-card" key={c.label}>
                <div className="config-label">{c.label}</div>
                <div className="config-val">{c.value}</div>
              </div>
            ))}
            <div style={{ marginTop: 'auto', display: 'flex', gap: 6 }}>
              <button className="btn-sm" style={{ flex: 1 }}>
                邀请成员
              </button>
              <button className="btn-sm primary" style={{ flex: 1 }}>
                升级套餐
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
