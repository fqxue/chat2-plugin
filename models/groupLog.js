/**
 * 极简的群聊消息记录，供伪人模式（BYM）的 contextual 发言策略使用。
 * 每个群保留最近的若干条消息（内存环形缓冲），不落盘。
 */

const logs = new Map()
const MAX_PER_GROUP = 50

export function recordGroupMessage (e) {
  if (!e?.isGroup || !e.group_id) return
  const text = (e.msg || '').trim()
  if (!text) return
  const list = logs.get(e.group_id) ?? []
  list.push({
    sender: e.sender?.card || e.sender?.nickname || String(e.user_id ?? ''),
    userId: e.user_id,
    text,
    time: new Date().toLocaleTimeString('zh-CN', { hour12: false })
  })
  while (list.length > MAX_PER_GROUP) {
    list.shift()
  }
  logs.set(e.group_id, list)
}

export function getRecentGroupMessages (groupId, n = 20) {
  const list = logs.get(groupId) ?? []
  return list.slice(Math.max(0, list.length - n))
}

export function clearGroupLog (groupId) {
  if (groupId === undefined) {
    logs.clear()
  } else {
    logs.delete(groupId)
  }
}
