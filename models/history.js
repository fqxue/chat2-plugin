import Config from '../config/config.js'

/**
 * 极简的内存会话历史。
 * key 为会话标识：群聊 `group:{group_id}`，私聊 `user:{user_id}`。
 * 历史超过 maxHistory 条时丢弃最旧的消息。
 */

const conversations = new Map()

export function historyKey (e) {
  if (e?.isGroup) return `group:${e.group_id ?? 'unknown'}`
  return `user:${e?.user_id ?? 'unknown'}`
}

export function getHistory (key) {
  return conversations.get(key) ?? []
}

export function pushHistory (key, message) {
  const list = conversations.get(key) ?? []
  list.push(message)
  const configuredMax = Number(Config.maxHistory)
  const max = Number.isFinite(configuredMax) ? Math.max(2, Math.floor(configuredMax)) : 20
  while (list.length > max) {
    list.shift()
  }
  conversations.set(key, list)
}

export function resetHistory (key) {
  return conversations.delete(key)
}

export function resetAllHistory () {
  conversations.clear()
}
