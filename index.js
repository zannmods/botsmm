const fs = require('fs')
const path = require('path')
const http = require('http')
const crypto = require('crypto')
const TelegramBot = require('node-telegram-bot-api')
const QRCode = require('qrcode')
const settings = require('./settings')

const DB_FILE = path.join(__dirname, settings.dbFile || 'database.json')
const WIB = 7 * 3600 * 1000
const FINAL = new Set(['completed', 'partial', 'canceled', 'cancelled', 'refunded', 'fail', 'failed'])
const REFUND_FULL = new Set(['canceled', 'cancelled', 'refunded', 'fail', 'failed'])
const ORDER_STATUS = {
  pending: 'Menunggu',
  'in progress': 'Diproses',
  processing: 'Diproses',
  completed: 'Selesai',
  partial: 'Sebagian',
  canceled: 'Dibatalkan',
  cancelled: 'Dibatalkan',
  refunded: 'Dikembalikan',
  fail: 'Gagal',
  failed: 'Gagal'
}
const ORDER_ICON = {
  pending: '⏳',
  'in progress': '🔄',
  processing: '🔄',
  completed: '✅',
  partial: '🟡',
  canceled: '❌',
  cancelled: '❌',
  refunded: '↩️',
  fail: '⚠️',
  failed: '⚠️'
}
const DEPOSIT_STATUS = {
  pending: 'Menunggu bayar',
  paid: 'Lunas',
  expired: 'Kedaluwarsa',
  canceled: 'Dibatalkan',
  failed: 'Gagal'
}
const DEPOSIT_ICON = { pending: '⏳', paid: '✅', expired: '⌛', canceled: '❌', failed: '⚠️' }
const SCREEN_IMG = {
  menu: 'menu',
  services: 'services',
  categories: 'services',
  items: 'services',
  service: 'services',
  search: 'services',
  order: 'orders',
  orders: 'orders',
  order_detail: 'orders',
  confirm: 'orders',
  done: 'success',
  deposit: 'deposit',
  history: 'deposit',
  account: 'account',
  referral: 'referral',
  info: 'info',
  help: 'help',
  admin: 'admin'
}
const LINE = '┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈'

class UserError extends Error {}

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const rp = n => 'Rp' + Math.round(Number(n) || 0).toLocaleString('id-ID')
const fmt = n => Number(n).toLocaleString('id-ID')
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s))
const chunk = (arr, n) => {
  const out = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}
const head = (icon, title) => `${icon} <b>${esc(title)}</b>\n${LINE}`
const quote = lines => `<blockquote>${lines.join('\n')}</blockquote>`
const stIcon = st => ORDER_ICON[String(st).toLowerCase()] || '▫️'
const stName = st => ORDER_STATUS[String(st).toLowerCase()] || String(st)
function bar(pct) {
  const full = Math.round(pct / 10)
  return '▰'.repeat(full) + '▱'.repeat(10 - full) + ` ${pct}%`
}
function greeting() {
  const h = new Date(Date.now() + WIB).getUTCHours()
  if (h < 11) return 'Selamat pagi'
  if (h < 15) return 'Selamat siang'
  if (h < 18) return 'Selamat sore'
  return 'Selamat malam'
}
const toInt = s => {
  const n = parseInt(String(s).replace(/[^\d]/g, ''), 10)
  return Number.isFinite(n) ? n : NaN
}
const toFloat = s => Number(String(s).trim().replace(',', '.').replace(/[^\d.]/g, ''))
const fmtDate = ts =>
  new Date(ts).toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })

function loadDb() {
  const base = {
    users: {},
    orders: {},
    deposits: {},
    config: {},
    meta: { orderSeq: 0, thumbs: {}, lowAlertAt: 0 }
  }
  try {
    const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))
    return { ...base, ...raw, meta: { ...base.meta, ...(raw.meta || {}) } }
  } catch {
    return base
  }
}

const db = loadDb()
db.config = {
  markup: { ...settings.pricing.markup },
  depositFee: { ...settings.deposit.fee },
  maintenance: false,
  ...db.config
}

let saveTimer = null
function flush() {
  clearTimeout(saveTimer)
  saveTimer = null
  const tmp = DB_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(db))
  fs.renameSync(tmp, DB_FILE)
}
function save() {
  if (!saveTimer) saveTimer = setTimeout(flush, 250)
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    flush()
    process.exit(0)
  })
}
process.on('unhandledRejection', e => log('unhandled', e && e.message))

if (!settings.botToken || settings.botToken.startsWith('ISI_')) {
  console.error('botToken belum diisi di settings.js')
  process.exit(1)
}

const bot = new TelegramBot(settings.botToken, { polling: true })
let botUsername = ''
const adminSet = new Set([settings.adminChatId, ...settings.admins].map(String))
const isAdmin = id => adminSet.has(String(id))
const conf = () => db.config
const zapaySandbox = () => String(settings.zapay.apiKey).startsWith('zps_')

const state = new Map()
const sessions = new Map()
const busy = new Set()
const lastAct = new Map()
const S = uid => {
  if (!sessions.has(uid)) sessions.set(uid, {})
  return sessions.get(uid)
}

const styleOn = settings.store.buttonStyle
const b = (text, data, style) => {
  const btn = { text, callback_data: data }
  if (style && styleOn) btn.style = style
  return btn
}
const link = (text, url, style) => {
  const btn = { text, url }
  if (style && styleOn) btn.style = style
  return btn
}

function paginate(items, page, size = settings.pageSize) {
  const pages = Math.max(1, Math.ceil(items.length / size))
  const p = Math.min(Math.max(0, page), pages - 1)
  return { items: items.slice(p * size, p * size + size), page: p, pages }
}
function pager(prefix, pg) {
  if (pg.pages <= 1) return []
  return [
    [
      pg.page > 0 ? b('‹', `${prefix}:${pg.page - 1}`) : b('·', 'noop'),
      b(`${pg.page + 1} / ${pg.pages}`, 'noop'),
      pg.page < pg.pages - 1 ? b('›', `${prefix}:${pg.page + 1}`) : b('·', 'noop')
    ]
  ]
}

function thumbFor(screen) {
  const key = SCREEN_IMG[screen] || screen
  const t = settings.store.thumbnails && settings.store.thumbnails[key]
  if (!t) return null
  const cached = db.meta.thumbs[key]
  if (cached && cached.src === t) return { key, src: t, id: cached.id, cached: true }
  if (/^https?:\/\//i.test(t)) return { key, src: t, id: t }
  const file = path.resolve(__dirname, t)
  return fs.existsSync(file) ? { key, src: t, file } : null
}

async function render(chatId, screen, text, rows, msg) {
  const base = { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } }
  const th = text.length <= 1000 ? thumbFor(screen) : null
  if (msg) {
    const hasPhoto = Boolean(msg.photo)
    try {
      if (!th && !hasPhoto) {
        return await bot.editMessageText(text, {
          ...base,
          chat_id: chatId,
          message_id: msg.message_id,
          disable_web_page_preview: true
        })
      }
      if (th && th.id && hasPhoto) {
        return await bot.editMessageMedia(
          { type: 'photo', media: th.id, caption: text, parse_mode: 'HTML' },
          { chat_id: chatId, message_id: msg.message_id, reply_markup: base.reply_markup }
        )
      }
    } catch (e) {
      if (String(e.message).includes('not modified')) return msg
    }
    bot.deleteMessage(chatId, msg.message_id).catch(() => {})
  }
  if (th) {
    try {
      const sent = await bot.sendPhoto(chatId, th.id || fs.createReadStream(th.file), { caption: text, ...base })
      if (sent.photo && !th.cached) {
        db.meta.thumbs[th.key] = { src: th.src, id: sent.photo[sent.photo.length - 1].file_id }
        save()
      }
      return sent
    } catch (e) {
      log('thumbnail gagal dikirim:', e.message)
      if (th.cached) {
        delete db.meta.thumbs[th.key]
        save()
      }
    }
  }
  return bot.sendMessage(chatId, text, { ...base, disable_web_page_preview: true })
}

function getUser(from) {
  const id = String(from.id)
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || 'User'
  let u = db.users[id]
  if (!u) {
    u = db.users[id] = {
      id,
      name,
      username: from.username || '',
      balance: 0,
      totalDeposit: 0,
      totalSpent: 0,
      orders: 0,
      banned: false,
      blocked: false,
      joined: Date.now(),
      ref: null,
      refEarned: 0,
      refPaid: false
    }
    save()
  }
  u.name = name
  u.username = from.username || ''
  u.blocked = false
  u.lastSeen = Date.now()
  return u
}

function notifyAdmin(text, rows) {
  const opts = { parse_mode: 'HTML', disable_web_page_preview: true }
  if (rows) opts.reply_markup = { inline_keyboard: rows }
  return bot.sendMessage(settings.adminChatId, text, opts).catch(e => log('notif admin gagal:', e.message))
}

async function smm(params) {
  const body = new URLSearchParams({ key: String(settings.indosmm.apiKey).trim(), ...params })
  const res = await fetch(settings.indosmm.apiUrl, { method: 'POST', body, signal: AbortSignal.timeout(30000) })
  const data = await res.json().catch(() => {
    throw new Error('Respons IndoSMM tidak valid')
  })
  if (data && !Array.isArray(data) && typeof data.error === 'string') throw new Error(data.error)
  return data
}

async function zapay(method, endpoint, payload) {
  const res = await fetch(settings.zapay.baseUrl + endpoint, {
    method,
    headers: {
      Authorization: `Bearer ${settings.zapay.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(20000)
  })
  const json = await res.json().catch(() => null)
  if (!json || !json.success) {
    const err = new Error((json && json.error && json.error.message) || `Zapay HTTP ${res.status}`)
    err.code = json && json.error && json.error.code
    throw err
  }
  return json.data
}

let svcCache = { at: 0, list: [], byId: new Map(), cats: [] }
async function loadServices(force) {
  const ttl = settings.indosmm.cacheMinutes * 60000
  if (!force && svcCache.list.length && Date.now() - svcCache.at < ttl) return svcCache
  try {
    const raw = await smm({ action: 'services' })
    const list = raw
      .filter(s => settings.indosmm.allowedTypes.includes(s.type))
      .map(s => ({
        id: Number(s.service),
        name: String(s.name),
        category: String(s.category),
        rate: Number(s.rate),
        min: Number(s.min),
        max: Number(s.max),
        refill: Boolean(s.refill),
        cancel: Boolean(s.cancel)
      }))
    const groups = new Map()
    for (const s of list) {
      if (!groups.has(s.category)) groups.set(s.category, [])
      groups.get(s.category).push(s)
    }
    const cats = [...groups.keys()].sort((x, y) => x.localeCompare(y)).map(name => ({ name, items: groups.get(name) }))
    svcCache = { at: Date.now(), list, byId: new Map(list.map(s => [s.id, s])), cats }
  } catch (e) {
    log('gagal ambil layanan:', e.message)
    if (!svcCache.list.length) throw new UserError('Daftar layanan belum bisa dimuat. Coba lagi sebentar.')
  }
  return svcCache
}

const costRate = s => s.rate
function sellRate(s) {
  const m = conf().markup
  return Math.ceil(m.type === 'percent' ? s.rate * (1 + m.value / 100) : s.rate + m.value)
}
const priceOf = (s, qty) => Math.ceil((sellRate(s) / 1000) * qty)
const costOf = (s, qty) => (costRate(s) * qty) / 1000
const markupLabel = () => (conf().markup.type === 'percent' ? `${conf().markup.value}%` : `${rp(conf().markup.value)} per 1.000`)

function feeOf(amount) {
  const f = conf().depositFee
  return f.type === 'percent' ? Math.ceil((amount * f.value) / 100) : Math.round(f.value)
}
const feeLabel = () => (conf().depositFee.type === 'percent' ? `${conf().depositFee.value}%` : rp(conf().depositFee.value))
const methodLabel = id => (settings.zapay.methods.find(m => m.id === id) || { label: id.toUpperCase() }).label

function orderProfit(o) {
  const st = String(o.status).toLowerCase()
  let done = 1
  if (REFUND_FULL.has(st)) done = 0
  else if (st === 'partial') done = Math.max(0, (o.quantity - o.remains) / o.quantity)
  return o.price - (o.refunded || 0) - o.cost * done
}

function platformKey(catName) {
  const n = catName.toLowerCase()
  const i = settings.platforms.findIndex(p => p.keys.some(k => n.includes(k)))
  return i === -1 ? 'o' : String(i)
}

const ctxFor = (user, chatId, msg, answer) => ({
  uid: user.id,
  user,
  chatId,
  msg,
  answer: answer || (() => {}),
  isAdmin: isAdmin(user.id)
})

async function showMenu(c) {
  const s = settings.store
  const text =
    `${head('🛍', s.name)}\n<i>${esc(s.tagline)}</i>\n\n` +
    quote([
      `👋 ${greeting()}, <b>${esc(c.user.name)}</b>`,
      `🆔 <code>${c.uid}</code>`,
      `💰 Saldo: <b>${rp(c.user.balance)}</b>`,
      `📦 Total pesanan: ${fmt(c.user.orders)}`
    ]) +
    `\n\nPilih menu di bawah.`
  const rows = [
    [b('🛒 Layanan', 'svc', 'primary'), b('💳 Isi Saldo', 'dep', 'success')],
    [b('🔥 Terlaris', 'top'), b('🔍 Cari Layanan', 'find')],
    [b('📦 Pesanan Saya', 'ol:0'), b('👤 Akun', 'acc')],
    [b('🎁 Referral', 'ref'), b('💬 Hubungi CS', 'cs')]
  ]
  const last = [b('ℹ️ Info', 'info')]
  if (s.channelUrl) last.push(link('📣 Channel', s.channelUrl))
  rows.push(last)
  if (c.isAdmin) rows.push([b('🛠 Panel Admin', 'ad', 'danger')])
  return render(c.chatId, 'menu', text, rows, c.msg)
}

async function showInfo(c) {
  const rules = settings.store.info.split('\n').filter(Boolean).map(x => `• ${esc(x)}`)
  const text =
    `${head('ℹ️', 'Info dan ketentuan')}\n\n${quote(rules)}\n\n` +
    `Harga layanan dihitung per 1.000. Saldo dipotong saat pesanan dibuat dan dikembalikan otomatis kalau pesanan dibatalkan atau gagal.`
  return render(c.chatId, 'info', text, [[b('💬 Hubungi CS', 'cs'), b('‹ Kembali', 'menu')]], c.msg)
}

async function showAccount(c) {
  const u = c.user
  const text =
    `${head('👤', 'Akun saya')}\n\n` +
    quote([
      `📛 ${esc(u.name)}`,
      `🆔 <code>${u.id}</code>`,
      `💰 Saldo: <b>${rp(u.balance)}</b>`,
      `📥 Total deposit: ${rp(u.totalDeposit)}`,
      `🛒 Total belanja: ${rp(u.totalSpent)}`,
      `📦 Pesanan: ${fmt(u.orders)}`,
      `📅 Bergabung: ${fmtDate(u.joined)}`
    ])
  const rows = [
    [b('💳 Isi Saldo', 'dep', 'success'), b('🧾 Riwayat Deposit', 'dh:0')],
    [b('📦 Pesanan Saya', 'ol:0'), b('🎁 Referral', 'ref')],
    [b('‹ Kembali', 'menu')]
  ]
  return render(c.chatId, 'account', text, rows, c.msg)
}

async function showReferral(c) {
  const r = settings.referral
  const invited = Object.values(db.users).filter(u => u.ref === c.uid).length
  const text =
    `${head('🎁', 'Referral')}\n\nAjak teman lewat link di bawah. Kamu dapat <b>${r.percent}%</b> dari ${r.firstDepositOnly ? 'deposit pertama' : 'setiap deposit'} mereka, langsung masuk saldo.\n\n` +
    `<code>https://t.me/${botUsername}?start=ref_${c.uid}</code>\n\n` +
    quote([`👥 Teman terdaftar: ${fmt(invited)}`, `💰 Bonus terkumpul: ${rp(c.user.refEarned)}`])
  const share = `https://t.me/share/url?url=${encodeURIComponent(`https://t.me/${botUsername}?start=ref_${c.uid}`)}&text=${encodeURIComponent('Beli followers, like, dan view murah di sini')}`
  return render(c.chatId, 'referral', text, [[link('📤 Bagikan Link', share, 'primary')], [b('‹ Kembali', 'menu')]], c.msg)
}

async function showPlatforms(c) {
  const svc = await loadServices()
  const counts = {}
  for (const cat of svc.cats) {
    const k = platformKey(cat.name)
    counts[k] = (counts[k] || 0) + 1
  }
  const btns = []
  settings.platforms.forEach((p, i) => {
    if (counts[i]) btns.push(b(`${p.icon || '▫️'} ${p.label}`, `pl:${i}:0`))
  })
  if (counts.o) btns.push(b('✨ Lainnya', 'pl:o:0'))
  const rows = [
    ...chunk(btns, 2),
    [b('📚 Semua kategori', 'pl:a:0')],
    [b('🔥 Terlaris', 'top'), b('🔍 Cari', 'find')],
    [b('‹ Kembali', 'menu')]
  ]
  const text = `${head('🛒', 'Daftar layanan')}\n\n${fmt(svc.list.length)} layanan di ${fmt(svc.cats.length)} kategori. Pilih platform.`
  return render(c.chatId, 'services', text, rows, c.msg)
}

async function showCategories(c, key, page) {
  const svc = await loadServices()
  S(c.uid).pl = key
  const list = svc.cats.map((cat, idx) => ({ cat, idx })).filter(x => key === 'a' || platformKey(x.cat.name) === key)
  const pg = paginate(list, page)
  const rows = pg.items.map(x => [b(clip(`📁 ${x.cat.name} (${x.cat.items.length})`, 56), `ct:${x.idx}:0`)])
  rows.push(...pager(`pl:${key}`, pg))
  rows.push([b('‹ Kembali', 'svc')])
  const label = key === 'a' ? 'Semua kategori' : key === 'o' ? 'Lainnya' : settings.platforms[Number(key)].label
  return render(c.chatId, 'categories', `${head('📂', label)}\n\n${fmt(list.length)} kategori. Pilih salah satu.`, rows, c.msg)
}

async function showServices(c, idx, page) {
  const svc = await loadServices()
  const cat = svc.cats[idx]
  if (!cat) return showPlatforms(c)
  const pg = paginate(cat.items, page)
  const rows = pg.items.map(s => [b(clip(`${s.refill ? '♻️ ' : ''}${rp(sellRate(s))} | ${s.name}`, 56), `s:${s.id}`)])
  rows.push(...pager(`ct:${idx}`, pg))
  rows.push([b('‹ Kembali', `pl:${S(c.uid).pl || 'a'}:0`)])
  const text = `${head('📋', cat.name)}\n\nHarga per 1.000. Tanda ♻️ berarti ada refill.`
  return render(c.chatId, 'items', text, rows, c.msg)
}

async function showService(c, id) {
  const svc = await loadServices()
  const s = svc.byId.get(id)
  if (!s) throw new UserError('Layanan sudah tidak tersedia.')
  const idx = svc.cats.findIndex(x => x.name === s.category)
  const text =
    `${head('🏷', 'Detail layanan')}\n<b>${esc(s.name)}</b>\n\n` +
    quote([
      `📁 ${esc(s.category)}`,
      `🆔 ID layanan: ${s.id}`,
      `💵 Harga: <b>${rp(sellRate(s))}</b> / 1.000`,
      `📉 Minimal: ${fmt(s.min)}`,
      `📈 Maksimal: ${fmt(s.max)}`,
      `♻️ Refill: ${s.refill ? 'Ya' : 'Tidak'}`,
      `🚫 Bisa dibatalkan: ${s.cancel ? 'Ya' : 'Tidak'}`
    ])
  const rows = [[b('🛒 Pesan Sekarang', `ord:${s.id}`, 'success')], [b('‹ Kembali', `ct:${Math.max(idx, 0)}:0`)]]
  return render(c.chatId, 'service', text, rows, c.msg)
}

async function startSearch(c) {
  state.set(c.uid, { step: 'search' })
  const text = `${head('🔍', 'Cari layanan')}\n\nKetik kata kunci, contoh: <i>instagram followers</i>.`
  return render(c.chatId, 'search', text, [[b('✖ Batal', 'menu', 'danger')]], c.msg)
}

async function showSearch(c, term) {
  const svc = await loadServices()
  const words = term.toLowerCase().split(/\s+/).filter(Boolean)
  const found = svc.list.filter(s => {
    const hay = `${s.name} ${s.category}`.toLowerCase()
    return words.every(w => hay.includes(w))
  })
  if (!found.length) {
    state.set(c.uid, { step: 'search' })
    return render(c.chatId, 'search', `${head('🔍', 'Tidak ditemukan')}\n\nTidak ada hasil untuk <b>${esc(term)}</b>. Coba kata kunci lain.`, [[b('‹ Kembali', 'menu')]], null)
  }
  const rows = found.slice(0, 10).map(s => [b(clip(`${s.refill ? '♻️ ' : ''}${rp(sellRate(s))} | ${s.name}`, 56), `s:${s.id}`)])
  rows.push([b('🔍 Cari lagi', 'find'), b('🏠 Menu', 'menu')])
  const more = found.length > 10 ? '\nMenampilkan 10 teratas, persempit kata kunci untuk hasil lebih pas.' : ''
  return render(c.chatId, 'search', `${head('🔍', `${fmt(found.length)} hasil`)}\n\nKata kunci: <i>${esc(term)}</i>${more}`, rows, null)
}

async function showTop(c) {
  const svc = await loadServices()
  const count = {}
  for (const o of Object.values(db.orders)) count[o.serviceId] = (count[o.serviceId] || 0) + 1
  const ids = Object.keys(count)
    .map(Number)
    .filter(id => svc.byId.has(id))
    .sort((x, y) => count[y] - count[x])
    .slice(0, 8)
  if (!ids.length) {
    return render(c.chatId, 'services', `${head('🔥', 'Terlaris')}\n\nBelum ada data penjualan. Lihat daftar layanan lengkap dulu.`, [[b('🛒 Layanan', 'svc', 'primary'), b('‹ Kembali', 'menu')]], c.msg)
  }
  const rows = ids.map(id => {
    const s = svc.byId.get(id)
    return [b(clip(`🔥 ${rp(sellRate(s))} | ${s.name}`, 56), `s:${id}`)]
  })
  rows.push([b('🛒 Semua Layanan', 'svc'), b('‹ Kembali', 'menu')])
  return render(c.chatId, 'services', `${head('🔥', 'Layanan terlaris')}\n\nPaling sering dipesan di toko ini.`, rows, c.msg)
}

async function startOrder(c, id) {
  const svc = await loadServices()
  const s = svc.byId.get(id)
  if (!s) throw new UserError('Layanan sudah tidak tersedia.')
  S(c.uid).order = { serviceId: id }
  state.set(c.uid, { step: 'qty', id })
  const text =
    `${head('🛒', 'Buat pesanan')}\n<b>${esc(s.name)}</b>\n\n` +
    quote([`📉 Minimal: ${fmt(s.min)}`, `📈 Maksimal: ${fmt(s.max)}`, `💵 Harga: ${rp(sellRate(s))} / 1.000`]) +
    `\n\n🔢 Kirim jumlah yang kamu mau.`
  return render(c.chatId, 'order', text, [[b('✖ Batal', `s:${id}`, 'danger')]], c.msg)
}

async function showOrderConfirm(c) {
  const draft = S(c.uid).order
  const svc = await loadServices()
  const s = svc.byId.get(draft.serviceId)
  if (!s) throw new UserError('Layanan sudah tidak tersedia.')
  const price = priceOf(s, draft.qty)
  const enough = c.user.balance >= price
  const lines = [
    `🛍 ${esc(s.name)}`,
    `🔗 <code>${esc(draft.link)}</code>`,
    `🔢 Jumlah: ${fmt(draft.qty)}`,
    `💵 Harga: <b>${rp(price)}</b>`,
    `💰 Saldo kamu: ${rp(c.user.balance)}`
  ]
  const rows = []
  let text
  if (enough) {
    lines.push(`🧮 Sisa saldo: ${rp(c.user.balance - price)}`)
    text = `${head('🧾', 'Konfirmasi pesanan')}\n\n${quote(lines)}\n\nCek lagi link dan jumlahnya sebelum lanjut.`
    rows.push([b('✅ Konfirmasi', 'ok', 'success'), b('✖ Batal', 'menu', 'danger')])
  } else {
    text = `${head('🧾', 'Konfirmasi pesanan')}\n\n${quote(lines)}\n\n⚠️ Saldo kurang <b>${rp(price - c.user.balance)}</b>. Isi saldo dulu lalu ulangi pesanan.`
    rows.push([b('💳 Isi Saldo', 'dep', 'success')], [b('✖ Batal', 'menu', 'danger')])
  }
  return render(c.chatId, 'confirm', text, rows, c.msg)
}

async function placeOrder(user, draft) {
  const svc = await loadServices()
  const s = svc.byId.get(draft.serviceId)
  if (!s) throw new UserError('Layanan sudah tidak tersedia.')
  if (draft.qty < s.min || draft.qty > s.max) throw new UserError('Jumlah di luar batas layanan.')
  const price = priceOf(s, draft.qty)
  if (user.balance < price) throw new UserError('Saldo tidak cukup.')
  user.balance -= price
  save()
  let res
  try {
    res = await smm({ action: 'add', service: s.id, link: draft.link, quantity: draft.qty })
    if (!res || !res.order) throw new Error('IndoSMM tidak mengembalikan ID order')
  } catch (e) {
    user.balance += price
    save()
    notifyAdmin(`<b>Order gagal ke IndoSMM</b>\nUser: ${esc(user.name)} <code>${user.id}</code>\nLayanan: ${s.id}\nPesan: ${esc(e.message)}`)
    throw new UserError('Pesanan gagal diproses dan saldo kamu tidak terpotong. Coba lagi nanti.')
  }
  const id = ++db.meta.orderSeq
  const order = {
    id,
    userId: user.id,
    providerId: String(res.order),
    serviceId: s.id,
    serviceName: s.name,
    link: draft.link,
    quantity: draft.qty,
    price,
    cost: costOf(s, draft.qty),
    status: 'Pending',
    remains: draft.qty,
    startCount: null,
    refill: s.refill,
    cancel: s.cancel,
    refunded: 0,
    created: Date.now()
  }
  db.orders[id] = order
  user.totalSpent += price
  user.orders += 1
  save()
  notifyAdmin(
    `<b>Pesanan baru #${id}</b>\nUser: ${esc(user.name)} <code>${user.id}</code>\nLayanan: ${esc(s.name)}\nJumlah: ${fmt(draft.qty)}\n` +
      `Harga: ${rp(price)}\nModal: ${rp(order.cost)}\nUntung: ${rp(price - order.cost)}`
  )
  return order
}

async function confirmOrder(c) {
  const draft = S(c.uid).order
  if (!draft || !draft.link || !draft.qty) throw new UserError('Sesi pesanan habis. Mulai lagi dari daftar layanan.')
  S(c.uid).order = null
  const order = await placeOrder(c.user, draft)
  const text =
    `${head('✅', 'Pesanan masuk')}\n\n` +
    quote([
      `🧾 Nomor: <b>#${order.id}</b>`,
      `🛍 ${esc(order.serviceName)}`,
      `🔢 Jumlah: ${fmt(order.quantity)}`,
      `💵 Dibayar: ${rp(order.price)}`,
      `💰 Sisa saldo: ${rp(c.user.balance)}`
    ]) +
    `\n\nStatus diperbarui otomatis. Kamu dapat notifikasi saat selesai.`
  return render(c.chatId, 'done', text, [[b('📦 Lihat Pesanan', `od:${order.id}`, 'primary'), b('🏠 Menu', 'menu')]], c.msg)
}

async function showOrders(c, page) {
  const list = Object.values(db.orders)
    .filter(o => o.userId === c.uid)
    .sort((x, y) => y.id - x.id)
  if (!list.length) {
    return render(c.chatId, 'orders', `${head('📦', 'Pesanan saya')}\n\nBelum ada pesanan.`, [[b('🛒 Lihat Layanan', 'svc', 'primary'), b('‹ Kembali', 'menu')]], c.msg)
  }
  const pg = paginate(list, page)
  const rows = pg.items.map(o => [b(clip(`${stIcon(o.status)} #${o.id} | ${o.serviceName}`, 56), `od:${o.id}`)])
  rows.push(...pager('ol', pg))
  rows.push([b('‹ Kembali', 'menu')])
  return render(c.chatId, 'orders', `${head('📦', 'Pesanan saya')}\n\nTotal ${fmt(list.length)} pesanan.`, rows, c.msg)
}

function ownOrder(c, id) {
  const o = db.orders[id]
  if (!o || (o.userId !== c.uid && !c.isAdmin)) throw new UserError('Pesanan tidak ditemukan.')
  return o
}

async function showOrder(c, id) {
  const o = ownOrder(c, id)
  const st = String(o.status).toLowerCase()
  const done = st === 'completed' ? o.quantity : Math.max(0, o.quantity - o.remains)
  const pct = Math.min(100, Math.round((done / o.quantity) * 100))
  const lines = [
    `🛍 ${esc(o.serviceName)}`,
    `🔗 <code>${esc(o.link)}</code>`,
    `🔢 Jumlah: ${fmt(o.quantity)}`,
    `💵 Harga: ${rp(o.price)}`
  ]
  if (o.startCount != null) lines.push(`🏁 Jumlah awal: ${fmt(o.startCount)}`)
  lines.push(`⏳ Sisa: ${fmt(o.remains)}`)
  if (o.refunded) lines.push(`↩️ Dikembalikan: ${rp(o.refunded)}`)
  lines.push(`📅 Dibuat: ${fmtDate(o.created)}`)
  const text =
    `${head(stIcon(o.status), `Pesanan #${o.id}`)}\nStatus: <b>${stName(o.status)}</b>\n<code>${bar(pct)}</code>\n\n${quote(lines)}`
  const rows = [[b('🔄 Perbarui', `or:${o.id}`, 'primary')]]
  const extra = []
  if (o.refill && st === 'completed') extra.push(b('♻️ Refill', `rf:${o.id}`, 'success'))
  if (o.cancel && !FINAL.has(st)) extra.push(b('🚫 Batalkan', `cn:${o.id}`, 'danger'))
  if (extra.length) rows.push(extra)
  rows.push([b('‹ Kembali', 'ol:0')])
  return render(c.chatId, 'order_detail', text, rows, c.msg)
}

function settleRefund(o) {
  if (o.refunded) return 0
  const st = String(o.status).toLowerCase()
  let amount = 0
  if (REFUND_FULL.has(st)) amount = o.price
  else if (st === 'partial') amount = Math.floor((o.price * Math.min(o.remains, o.quantity)) / o.quantity)
  const user = db.users[o.userId]
  if (amount > 0 && user) {
    user.balance += amount
    user.totalSpent = Math.max(0, user.totalSpent - amount)
    o.refunded = amount
  }
  return amount
}

async function applyStatus(o, info) {
  if (!info || info.error || !info.status) return
  const prev = String(o.status).toLowerCase()
  o.status = info.status
  o.remains = Number(info.remains || 0)
  if (info.start_count != null) o.startCount = Number(info.start_count)
  const now = String(o.status).toLowerCase()
  if (now === prev) return
  let refunded = 0
  if (FINAL.has(now)) refunded = settleRefund(o)
  save()
  let text = `${head(stIcon(now), `Pesanan #${o.id}`)}\n${esc(o.serviceName)}\nStatus: <b>${stName(now)}</b>`
  if (refunded) text += `\n↩️ Saldo dikembalikan: ${rp(refunded)}`
  const rows = [[b('🔎 Detail', `od:${o.id}`, 'primary'), b('🏠 Menu', 'menu')]]
  if (FINAL.has(now) || now === 'in progress') {
    bot.sendMessage(o.userId, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } }).catch(() => {})
  }
}

let syncing = false
async function syncOrders() {
  if (syncing) return
  syncing = true
  try {
    const active = Object.values(db.orders).filter(o => !FINAL.has(String(o.status).toLowerCase()))
    for (const group of chunk(active, 100)) {
      let res
      try {
        res = await smm({ action: 'status', orders: group.map(o => o.providerId).join(',') })
      } catch (e) {
        log('sync order gagal:', e.message)
        continue
      }
      for (const o of group) {
        const info = res[o.providerId] || (group.length === 1 && res.status ? res : null)
        await applyStatus(o, info)
      }
    }
  } finally {
    syncing = false
  }
}

async function checkProviderBalance() {
  try {
    const res = await smm({ action: 'balance' })
    const bal = Number(res.balance)
    if (bal < settings.indosmm.lowBalance && Date.now() - db.meta.lowAlertAt > 12 * 3600 * 1000) {
      db.meta.lowAlertAt = Date.now()
      save()
      notifyAdmin(`<b>Saldo IndoSMM menipis</b>\nSisa ${esc(res.balance)} ${esc(res.currency || 'IDR')}. Segera isi supaya pesanan tidak gagal.`)
    }
  } catch (e) {
    log('cek saldo provider gagal:', e.message)
  }
}

async function showDeposit(c) {
  const d = settings.deposit
  const text =
    `${head('💳', 'Isi saldo')}\n\n` +
    quote([`📥 Minimal: ${rp(d.min)}`, `📤 Maksimal: ${rp(d.max)}`, `🧾 Biaya layanan: ${feeLabel()} dari nominal`]) +
    `\n\nPilih nominal atau ketik sendiri.`
  const rows = [
    ...chunk(d.presets.map(v => b(`💵 ${rp(v)}`, `da:${v}`)), 2),
    [b('⌨️ Nominal Lain', 'dc', 'primary')],
    [b('🧾 Riwayat Deposit', 'dh:0'), b('‹ Kembali', 'menu')]
  ]
  return render(c.chatId, 'deposit', text, rows, c.msg)
}

async function customAmount(c) {
  state.set(c.uid, { step: 'dep_amount' })
  const d = settings.deposit
  const text = `${head('⌨️', 'Nominal deposit')}\n\nKetik angka saja, contoh <code>75000</code>.\nMinimal ${rp(d.min)}, maksimal ${rp(d.max)}.`
  return render(c.chatId, 'deposit', text, [[b('✖ Batal', 'dep', 'danger')]], c.msg)
}

async function pickAmount(c, amount) {
  const d = settings.deposit
  if (!Number.isFinite(amount) || amount < d.min || amount > d.max) {
    throw new UserError(`Nominal harus antara ${rp(d.min)} sampai ${rp(d.max)}.`)
  }
  S(c.uid).dep = { amount }
  const btns = settings.zapay.methods.map(m => b(`${m.icon || '💳'} ${m.label}`, `dm:${m.id}`))
  const text = `${head('🏦', 'Metode pembayaran')}\n\n${quote([`💰 Saldo masuk: <b>${rp(amount)}</b>`])}\n\nPilih cara bayar.`
  return render(c.chatId, 'deposit', text, [...chunk(btns, 2), [b('✏️ Ganti Nominal', 'dep'), b('✖ Batal', 'menu', 'danger')]], c.msg)
}

async function pickMethod(c, method) {
  const dep = S(c.uid).dep
  if (!dep) throw new UserError('Sesi deposit habis. Mulai lagi dari menu isi saldo.')
  if (!settings.zapay.methods.some(m => m.id === method)) throw new UserError('Metode tidak tersedia.')
  dep.method = method
  const extra = feeOf(dep.amount)
  const payAmount = dep.amount + extra
  let total = null
  try {
    const q = await zapay('GET', `/biaya?method=${method}&amount=${payAmount}&fee_bearer=${settings.zapay.feeBearer}`)
    if (q && Number.isFinite(Number(q.total))) total = Number(q.total)
  } catch (e) {
    log('cek biaya gagal:', e.message)
  }
  const lines = [
    `🏦 Metode: ${methodLabel(method)}`,
    `💰 Saldo masuk: <b>${rp(dep.amount)}</b>`,
    `🧾 Biaya layanan: ${rp(extra)}`,
    `🧮 Subtotal: ${rp(payAmount)}`
  ]
  if (total) lines.push(`💳 Total bayar: <b>${rp(total)}</b>`)
  const note = total ? '' : '\n\nTotal akhir tampil di halaman pembayaran.'
  const text = `${head('🧾', 'Konfirmasi deposit')}\n\n${quote(lines)}${note}`
  const rows = [[b('✅ Bayar Sekarang', 'dgo', 'success')], [b('🔁 Ganti Metode', `da:${dep.amount}`), b('✖ Batal', 'menu', 'danger')]]
  return render(c.chatId, 'deposit', text, rows, c.msg)
}

function depositText(d) {
  const p = d.payment || {}
  const title = d.status === 'pending' ? 'Menunggu pembayaran' : `Deposit ${DEPOSIT_STATUS[d.status].toLowerCase()}`
  const lines = [`🏦 Metode: ${methodLabel(d.method)}`]
  if (p.va_number) lines.push(`🏛 Bank: ${esc(String(p.bank || d.method).toUpperCase())}`, `🔢 Nomor VA: <code>${esc(p.va_number)}</code>`)
  if (p.bill_key) lines.push(`🏛 Kode biller: <code>${esc(p.biller_code)}</code>`, `🔑 Kunci bayar: <code>${esc(p.bill_key)}</code>`)
  lines.push(`💰 Saldo masuk: ${rp(d.amount)}`, `💳 Total bayar: <b>${rp(d.total)}</b>`)
  if (d.status === 'pending' && p.expires_at) lines.push(`⏰ Bayar sebelum: ${esc(p.expires_at)} WIB`)
  lines.push(`🆔 <code>${d.id}</code>`)
  let text = `${head(DEPOSIT_ICON[d.status], title)}\n\n${quote(lines)}`
  if (d.sandbox) text += '\n\n🧪 Mode sandbox, tidak ada uang sungguhan.'
  return text
}

function depositRows(d) {
  if (d.status !== 'pending') return [[b('🧾 Riwayat', 'dh:0'), b('🏠 Menu', 'menu')]]
  const rows = [
    [link('💳 Buka Halaman Bayar', d.payUrl, 'success')],
    [b('🔄 Cek Status', `dk:${d.id}`, 'primary'), b('🚫 Batalkan', `dx:${d.id}`, 'danger')]
  ]
  if (d.sandbox) rows.push([b('🧪 Simulasi Lunas', `dsim:${d.id}`)])
  rows.push([b('🏠 Menu', 'menu')])
  return rows
}

async function sendPayment(d) {
  const text = depositText(d)
  const markup = { inline_keyboard: depositRows(d) }
  const p = d.payment || {}
  const opts = { caption: text, parse_mode: 'HTML', reply_markup: markup }
  let sent = null
  if (p.qr_string) {
    const buf = await QRCode.toBuffer(p.qr_string, { width: 480, margin: 2 })
    sent = await bot.sendPhoto(d.userId, buf, opts, { filename: 'qris.png', contentType: 'image/png' })
  } else if (p.qr_url) {
    sent = await bot.sendPhoto(d.userId, p.qr_url, opts).catch(() => null)
  }
  if (!sent) sent = await bot.sendMessage(d.userId, text, { parse_mode: 'HTML', reply_markup: markup })
  d.messageId = sent.message_id
  save()
}

async function createDepositFlow(c) {
  const draft = S(c.uid).dep
  if (!draft || !draft.method) throw new UserError('Sesi deposit habis. Mulai lagi dari menu isi saldo.')
  const pending = Object.values(db.deposits).filter(d => d.userId === c.uid && d.status === 'pending')
  if (pending.length >= settings.deposit.maxPending) {
    throw new UserError(`Masih ada ${pending.length} deposit menunggu bayar. Selesaikan atau batalkan dulu.`)
  }
  S(c.uid).dep = null
  const extra = feeOf(draft.amount)
  const payAmount = draft.amount + extra
  const orderId = `DEP-${c.uid}-${Date.now().toString(36)}`
  let data
  try {
    data = await zapay('POST', '/createtransaksi', {
      order_id: orderId,
      amount: payAmount,
      method: draft.method,
      fee_bearer: settings.zapay.feeBearer,
      description: clip(`Isi saldo ${settings.store.name}`, 100)
    })
  } catch (e) {
    log('createtransaksi gagal:', e.message)
    notifyAdmin(`<b>Zapay gagal buat transaksi</b>\nUser: <code>${c.uid}</code>\nPesan: ${esc(e.message)}`)
    throw new UserError('Pembayaran belum bisa dibuat. Coba lagi sebentar.')
  }
  const dep = {
    id: orderId,
    userId: c.uid,
    amount: draft.amount,
    extra,
    payAmount,
    method: draft.method,
    status: 'pending',
    total: Number(data.total) || payAmount,
    fee: Number(data.fee) || 0,
    payUrl: data.pay_url,
    payment: data.payment || {},
    sandbox: Boolean(data.sandbox),
    created: Date.now(),
    checkedAt: 0,
    messageId: null
  }
  db.deposits[orderId] = dep
  save()
  if (c.msg) bot.deleteMessage(c.chatId, c.msg.message_id).catch(() => {})
  await sendPayment(dep)
}

async function showDepositHistory(c, page) {
  const list = Object.values(db.deposits)
    .filter(d => d.userId === c.uid)
    .sort((x, y) => y.created - x.created)
  if (!list.length) {
    return render(c.chatId, 'history', `${head('🧾', 'Riwayat deposit')}\n\nBelum ada deposit.`, [[b('💳 Isi Saldo', 'dep', 'success'), b('‹ Kembali', 'acc')]], c.msg)
  }
  const pg = paginate(list, page)
  const rows = pg.items.map(d => [b(`${DEPOSIT_ICON[d.status]} ${fmtDate(d.created)} | ${rp(d.amount)}`, `dv:${d.id}`)])
  rows.push(...pager('dh', pg))
  rows.push([b('‹ Kembali', 'acc')])
  return render(c.chatId, 'history', `${head('🧾', 'Riwayat deposit')}\n\nTotal ${fmt(list.length)} deposit.`, rows, c.msg)
}

function ownDeposit(c, id) {
  const d = db.deposits[id]
  if (!d || (d.userId !== c.uid && !c.isAdmin)) throw new UserError('Deposit tidak ditemukan.')
  return d
}

async function showDepositDetail(c, id) {
  const d = ownDeposit(c, id)
  const rows = depositRows(d)
  if (d.status !== 'pending') rows[0] = [b('‹ Kembali', 'dh:0'), b('🏠 Menu', 'menu')]
  return render(c.chatId, 'history', depositText(d), rows, c.msg)
}

async function creditDeposit(dep, data) {
  if (dep.status === 'paid') return
  const user = db.users[dep.userId]
  dep.status = 'paid'
  dep.paidAt = Date.now()
  const net = Number(data && data.net)
  dep.profit = Number.isFinite(net) && net > 0 ? net - dep.amount : dep.extra
  user.balance += dep.amount
  user.totalDeposit += dep.amount
  const ref = settings.referral
  const referrer = user.ref && db.users[user.ref]
  if (referrer && ref.percent > 0 && !(ref.firstDepositOnly && user.refPaid)) {
    const bonus = Math.floor((dep.amount * ref.percent) / 100)
    if (bonus > 0) {
      referrer.balance += bonus
      referrer.refEarned += bonus
      user.refPaid = true
      bot
        .sendMessage(referrer.id, `<b>Bonus referral</b>\n\n${esc(user.name)} baru deposit. Kamu dapat ${rp(bonus)}, saldo sekarang ${rp(referrer.balance)}.`, { parse_mode: 'HTML' })
        .catch(() => {})
    }
  }
  save()
  if (dep.messageId) bot.deleteMessage(dep.userId, dep.messageId).catch(() => {})
  bot
    .sendMessage(user.id, `${head('✅', 'Deposit berhasil')}\n\n${quote([`💰 Saldo masuk: ${rp(dep.amount)}`, `💼 Saldo sekarang: <b>${rp(user.balance)}</b>`])}`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[b('🛒 Lihat Layanan', 'svc', 'success'), b('🏠 Menu', 'menu')]] }
    })
    .catch(() => {})
  notifyAdmin(
    `<b>Deposit lunas</b>${dep.sandbox ? ' (sandbox)' : ''}\nUser: ${esc(user.name)} <code>${user.id}</code>\nMetode: ${methodLabel(dep.method)}\n` +
      `Saldo masuk: ${rp(dep.amount)}\nUntung deposit: ${rp(dep.profit)}`
  )
}

async function closeDeposit(dep, status) {
  if (dep.status !== 'pending') return
  dep.status = status
  save()
  if (dep.messageId) bot.deleteMessage(dep.userId, dep.messageId).catch(() => {})
  bot
    .sendMessage(dep.userId, `${head(DEPOSIT_ICON[status], `Deposit ${DEPOSIT_STATUS[status].toLowerCase()}`)}\n\n${quote([`🆔 <code>${dep.id}</code>`, `💰 Nominal: ${rp(dep.amount)}`])}`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[b('💳 Isi Saldo Lagi', 'dep', 'primary'), b('🏠 Menu', 'menu')]] }
    })
    .catch(() => {})
}

async function syncDeposit(dep) {
  const data = await zapay('GET', `/statustransaksi?order_id=${encodeURIComponent(dep.id)}`)
  if (data.status === 'paid') {
    if (Number(data.amount) === dep.payAmount) await creditDeposit(dep, data)
    else notifyAdmin(`<b>Nominal tidak cocok</b>\nDeposit <code>${dep.id}</code>\nDiharapkan ${rp(dep.payAmount)}, diterima ${rp(data.amount)}. Saldo tidak ditambahkan.`)
  } else if (['expired', 'canceled', 'failed'].includes(data.status)) {
    await closeDeposit(dep, data.status)
  }
  return data.status
}

let polling = false
async function pollDeposits() {
  if (polling) return
  polling = true
  try {
    const list = Object.values(db.deposits)
      .filter(d => d.status === 'pending')
      .sort((x, y) => x.checkedAt - y.checkedAt)
      .slice(0, 25)
    for (const d of list) {
      d.checkedAt = Date.now()
      try {
        await syncDeposit(d)
      } catch (e) {
        log('poll deposit gagal:', e.message)
      }
      await sleep(300)
    }
  } finally {
    polling = false
  }
}

function handleWebhook(raw, headers, res) {
  const sig = Buffer.from(String(headers['x-zapay-signature'] || ''))
  const expected = Buffer.from(crypto.createHmac('sha256', settings.zapay.apiKey).update(raw).digest('hex'))
  if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) {
    res.writeHead(403)
    return res.end('invalid signature')
  }
  let evt
  try {
    evt = JSON.parse(raw.toString('utf8'))
  } catch {
    res.writeHead(400)
    return res.end('bad json')
  }
  if (!(Math.abs(Date.now() / 1000 - Number(evt.timestamp)) <= 600)) {
    res.writeHead(400)
    return res.end('stale')
  }
  res.writeHead(200)
  res.end('ok')
  processWebhook(evt).catch(e => log('webhook error:', e.message))
}

async function processWebhook(evt) {
  const data = evt.data || {}
  const dep = db.deposits[data.order_id]
  if (!dep) return
  if (evt.event === 'payment.paid') {
    if (Number(data.amount) !== dep.payAmount) {
      return notifyAdmin(`<b>Webhook nominal tidak cocok</b>\nDeposit <code>${dep.id}</code>\nDiharapkan ${rp(dep.payAmount)}, diterima ${rp(data.amount)}. Saldo tidak ditambahkan.`)
    }
    return creditDeposit(dep, data)
  }
  const map = { 'payment.expired': 'expired', 'payment.canceled': 'canceled', 'payment.failed': 'failed' }
  if (map[evt.event]) return closeDeposit(dep, map[evt.event])
}

function startWebhookServer() {
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0]
    if (req.method === 'GET' && url === '/') {
      res.writeHead(200)
      return res.end('ok')
    }
    if (req.method !== 'POST' || url !== settings.zapay.webhookPath) {
      res.writeHead(404)
      return res.end()
    }
    const chunks = []
    let size = 0
    req.on('data', part => {
      size += part.length
      if (size > 65536) {
        res.writeHead(413)
        res.end()
        req.destroy()
        return
      }
      chunks.push(part)
    })
    req.on('end', () => {
      if (size <= 65536) handleWebhook(Buffer.concat(chunks), req.headers, res)
    })
  })
  server.listen(settings.zapay.webhookPort, () => log(`webhook zapay di port ${settings.zapay.webhookPort}${settings.zapay.webhookPath}`))
}

async function startCs(c) {
  state.set(c.uid, { step: 'cs' })
  const rows = [[b('✖ Batal', 'menu', 'danger')]]
  if (settings.store.supportUsername) rows.unshift([link('💬 Chat Langsung', `https://t.me/${settings.store.supportUsername.replace('@', '')}`, 'primary')])
  const text = `${head('💬', 'Hubungi CS')}\n\nTulis pesanmu sekarang. Boleh teks, foto, atau file. Balasan masuk lewat bot ini.`
  return render(c.chatId, 'help', text, rows, c.msg)
}

function adminRows() {
  return [
    [b('📊 Statistik', 'ast', 'primary'), b('💼 Saldo Provider', 'abal')],
    [b('📣 Broadcast', 'ab', 'success'), b('👥 Kelola User', 'au')],
    [b('💹 Harga dan Fee', 'ap'), b('🔄 Refresh Layanan', 'arf')],
    [b(`🚧 Maintenance: ${conf().maintenance ? 'ON' : 'OFF'}`, 'amt', conf().maintenance ? 'danger' : undefined), b('💾 Backup DB', 'adb')],
    [b('‹ Kembali', 'menu')]
  ]
}

async function showAdmin(c) {
  const mode = zapaySandbox() ? 'sandbox' : 'live'
  const pending = Object.values(db.deposits).filter(d => d.status === 'pending').length
  const active = Object.values(db.orders).filter(o => !FINAL.has(String(o.status).toLowerCase())).length
  const text =
    `${head('🛠', 'Panel admin')}\n\n` +
    quote([
      `💳 Pembayaran: ${mode}`,
      `👥 User: ${fmt(Object.keys(db.users).length)}`,
      `📦 Pesanan berjalan: ${fmt(active)}`,
      `⏳ Deposit menunggu: ${fmt(pending)}`,
      `📚 Layanan di cache: ${fmt(svcCache.list.length)}`
    ])
  return render(c.chatId, 'admin', text, adminRows(), c.msg)
}

function statsOf() {
  const users = Object.values(db.users)
  const orders = Object.values(db.orders)
  const deps = Object.values(db.deposits).filter(d => d.status === 'paid')
  const t = Date.now() + WIB
  const dayStart = t - (t % 86400000) - WIB
  const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0)
  const calc = since => {
    const o = orders.filter(x => x.created >= since)
    const d = deps.filter(x => x.paidAt >= since)
    return {
      orders: o.length,
      revenue: sum(o, x => x.price - (x.refunded || 0)),
      orderProfit: sum(o, orderProfit),
      deposits: d.length,
      depositSum: sum(d, x => x.amount),
      depositProfit: sum(d, x => x.profit || 0)
    }
  }
  return {
    users: users.length,
    newToday: users.filter(u => u.joined >= dayStart).length,
    liability: sum(users, u => u.balance),
    today: calc(dayStart),
    all: calc(0)
  }
}

async function showStats(c) {
  const s = statsOf()
  const block = (title, x) =>
    `<b>${title}</b>\nPesanan: ${fmt(x.orders)} | Omzet: ${rp(x.revenue)}\nUntung pesanan: ${rp(x.orderProfit)}\n` +
    `Deposit: ${fmt(x.deposits)} | ${rp(x.depositSum)}\nUntung deposit: ${rp(x.depositProfit)}\n<b>Total untung: ${rp(x.orderProfit + x.depositProfit)}</b>`
  const text =
    `${head('📊', 'Statistik')}\n\n👥 User: ${fmt(s.users)} (baru hari ini ${fmt(s.newToday)})\n💼 Saldo user beredar: ${rp(s.liability)}\n\n` +
    `${block('📅 Hari ini', s.today)}\n\n${block('🗂 Semua waktu', s.all)}`
  return render(c.chatId, 'admin', text, [[b('🔄 Perbarui', 'ast', 'primary'), b('‹ Kembali', 'ad')]], c.msg)
}

async function showBalances(c) {
  const lines = [head('💼', 'Saldo provider'), '']
  try {
    const r = await smm({ action: 'balance' })
    lines.push(`IndoSMM: ${esc(r.balance)} ${esc(r.currency || 'IDR')}`)
  } catch (e) {
    lines.push(`IndoSMM: gagal (${esc(e.message)})`)
  }
  try {
    const r = await zapay('GET', '/saldo')
    lines.push('', 'Zapay:')
    for (const [k, v] of Object.entries(r)) lines.push(`${esc(k)}: ${typeof v === 'number' ? rp(v) : esc(JSON.stringify(v))}`)
  } catch (e) {
    lines.push('', `Zapay: gagal (${esc(e.message)})`)
  }
  return render(c.chatId, 'admin', lines.join('\n'), [[b('🔄 Perbarui', 'abal', 'primary'), b('‹ Kembali', 'ad')]], c.msg)
}

async function showPrices(c) {
  const text =
    `${head('💹', 'Harga dan fee')}\n\nMarkup layanan: <b>${markupLabel()}</b>\nFee deposit: <b>${feeLabel()}</b>\n\n` +
    `Contoh: layanan modal Rp1.000 dengan markup 50% dijual Rp1.500. Markup rupiah dihitung per 1.000 jumlah.`
  const rows = [
    [b('📈 Markup %', 'set:markup:percent'), b('📈 Markup Rp', 'set:markup:flat')],
    [b('🧾 Fee Deposit %', 'set:depositFee:percent'), b('🧾 Fee Deposit Rp', 'set:depositFee:flat')],
    [b('‹ Kembali', 'ad')]
  ]
  return render(c.chatId, 'admin', text, rows, c.msg)
}

async function askSetting(c, key, kind) {
  state.set(c.uid, { step: 'adm_set', key, kind })
  const names = { markup: 'markup layanan', depositFee: 'fee deposit' }
  if (!names[key] || !['percent', 'flat'].includes(kind)) throw new UserError('Pengaturan tidak dikenal.')
  const hint = kind === 'percent' ? 'Ketik angka persen, contoh 50 atau 2,5.' : 'Ketik angka rupiah, contoh 1500.'
  return render(c.chatId, 'admin', `${head('💹', `Ubah ${names[key]}`)}\n\n${hint}`, [[b('✖ Batal', 'ap', 'danger')]], c.msg)
}

async function applySetting(c, st, text) {
  if (st.kind === 'percent') {
    const v = toFloat(text)
    if (!Number.isFinite(v) || v < 0 || v > 1000) throw new UserError('Angka persen tidak valid.')
    conf()[st.key] = { type: 'percent', value: v }
  } else {
    const v = toInt(text)
    if (!Number.isFinite(v) || v < 0) throw new UserError('Angka tidak valid.')
    conf()[st.key] = { type: 'flat', value: v }
  }
  save()
  state.delete(c.uid)
  return showPrices({ ...c, msg: null })
}

function userCard(u) {
  const text =
    `${head('👤', u.name)} ${u.username ? '@' + esc(u.username) : ''}\n\n` +
    quote([
      `🆔 <code>${u.id}</code>`,
      `💰 Saldo: <b>${rp(u.balance)}</b>`,
      `📥 Deposit: ${rp(u.totalDeposit)}`,
      `🛒 Belanja: ${rp(u.totalSpent)}`,
      `📦 Pesanan: ${fmt(u.orders)}`,
      `📅 Bergabung: ${fmtDate(u.joined)}`,
      `${u.banned ? '⛔ Diblokir' : '🟢 Aktif'}`
    ])
  const rows = [
    [b('➕ Tambah Saldo', `uf:${u.id}:add`, 'success'), b('➖ Kurangi Saldo', `uf:${u.id}:sub`)],
    [u.banned ? b('✅ Buka Blokir', `uf:${u.id}:unban`, 'success') : b('⛔ Blokir', `uf:${u.id}:ban`, 'danger')],
    [b('‹ Kembali', 'ad')]
  ]
  return { text, rows }
}

async function userAction(c, id, act) {
  const u = db.users[id]
  if (!u) throw new UserError('User tidak ditemukan.')
  if (act === 'add' || act === 'sub') {
    state.set(c.uid, { step: 'adm_amt', id, act })
    return render(c.chatId, 'admin', `Ketik nominal untuk ${act === 'add' ? 'menambah' : 'mengurangi'} saldo <b>${esc(u.name)}</b>.`, [[b('Batal', 'ad', 'danger')]], c.msg)
  }
  u.banned = act === 'ban'
  save()
  c.answer(u.banned ? 'User diblokir' : 'Blokir dibuka')
  const card = userCard(u)
  return render(c.chatId, 'admin', card.text, card.rows, c.msg)
}

async function runBroadcast(src) {
  const targets = Object.values(db.users).filter(u => !u.banned && !u.blocked)
  let ok = 0
  let fail = 0
  for (const u of targets) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await bot.copyMessage(u.id, src.chatId, src.messageId)
        ok++
        break
      } catch (e) {
        const wait = e.response && e.response.body && e.response.body.parameters && e.response.body.parameters.retry_after
        if (wait && attempt === 0) {
          await sleep(wait * 1000 + 200)
          continue
        }
        fail++
        if (/blocked|deactivated|chat not found/i.test(e.message)) u.blocked = true
        break
      }
    }
    await sleep(45)
  }
  save()
  notifyAdmin(`<b>Broadcast selesai</b>\nTerkirim: ${fmt(ok)}\nGagal: ${fmt(fail)}`)
}

async function handleInput(c, msg) {
  const st = state.get(c.uid)
  const text = (msg.text || '').trim()
  if (!st) return showMenu(c)
  if (st.step.startsWith('adm_') && !c.isAdmin) {
    state.delete(c.uid)
    return
  }
  switch (st.step) {
    case 'qty': {
      const svc = await loadServices()
      const s = svc.byId.get(st.id)
      if (!s) throw new UserError('Layanan sudah tidak tersedia.')
      const qty = toInt(text)
      if (!Number.isFinite(qty) || qty < s.min || qty > s.max) {
        throw new UserError(`Jumlah harus antara ${fmt(s.min)} dan ${fmt(s.max)}.`)
      }
      S(c.uid).order = { serviceId: s.id, qty }
      state.set(c.uid, { step: 'link', id: s.id })
      return render(c.chatId, 'order', `${head('🔗', 'Link target')}\n\n${quote([`🔢 Jumlah: <b>${fmt(qty)}</b>`, `💵 Harga: <b>${rp(priceOf(s, qty))}</b>`])}\n\nSekarang kirim link target.`, [[b('✖ Batal', `s:${s.id}`, 'danger')]], null)
    }
    case 'link': {
      if (!text || text.length > 500 || /\s/.test(text)) throw new UserError('Link tidak valid. Kirim satu link tanpa spasi.')
      S(c.uid).order.link = text
      state.delete(c.uid)
      return showOrderConfirm({ ...c, msg: null })
    }
    case 'search': {
      if (text.length < 2) throw new UserError('Kata kunci terlalu pendek.')
      state.delete(c.uid)
      return showSearch(c, text)
    }
    case 'dep_amount': {
      const amount = toInt(text)
      state.delete(c.uid)
      return pickAmount(c, amount)
    }
    case 'cs': {
      state.delete(c.uid)
      const u = c.user
      await notifyAdmin(
        `<b>Pesan CS</b>\n${esc(u.name)} ${u.username ? '@' + esc(u.username) : ''}\nID: <code>${u.id}</code> | Saldo: ${rp(u.balance)}`,
        [[b('Balas', `ar:${u.id}`, 'primary')]]
      )
      await bot.copyMessage(settings.adminChatId, msg.chat.id, msg.message_id)
      return render(c.chatId, 'help', 'Pesan terkirim ke CS. Balasan akan masuk lewat bot ini.', [[b('Menu', 'menu')]], null)
    }
    case 'adm_uid': {
      const id = toInt(text)
      const u = db.users[String(id)]
      if (!u) throw new UserError('User dengan ID itu tidak ada di database.')
      state.delete(c.uid)
      const card = userCard(u)
      return render(c.chatId, 'admin', card.text, card.rows, null)
    }
    case 'adm_amt': {
      const amount = toInt(text)
      const u = db.users[st.id]
      if (!Number.isFinite(amount) || amount <= 0) throw new UserError('Nominal tidak valid.')
      if (st.act === 'sub' && amount > u.balance) throw new UserError('Nominal melebihi saldo user.')
      u.balance += st.act === 'add' ? amount : -amount
      save()
      state.delete(c.uid)
      bot
        .sendMessage(u.id, `Saldo kamu ${st.act === 'add' ? 'bertambah' : 'berkurang'} ${rp(amount)} oleh admin.\nSaldo sekarang: <b>${rp(u.balance)}</b>`, { parse_mode: 'HTML' })
        .catch(() => {})
      const card = userCard(u)
      return render(c.chatId, 'admin', card.text, card.rows, null)
    }
    case 'adm_set':
      return applySetting(c, st, text)
    case 'adm_bc': {
      S(c.uid).bc = { chatId: msg.chat.id, messageId: msg.message_id }
      state.delete(c.uid)
      const total = Object.values(db.users).filter(u => !u.banned && !u.blocked).length
      return render(
        c.chatId,
        'admin',
        `Pesan di atas akan dikirim ke <b>${fmt(total)}</b> user. Kirim sekarang?`,
        [[b('🚀 Kirim', 'abg', 'success'), b('✖ Batal', 'ad', 'danger')]],
        null
      )
    }
    case 'adm_reply': {
      state.delete(c.uid)
      const kb = { inline_keyboard: [[b('Balas CS', 'cs'), b('Menu', 'menu')]] }
      if (msg.text) {
        await bot.sendMessage(st.to, `<b>Balasan CS</b>\n\n${esc(msg.text)}`, { parse_mode: 'HTML', reply_markup: kb })
      } else {
        await bot.sendMessage(st.to, '<b>Balasan CS</b>', { parse_mode: 'HTML' })
        await bot.copyMessage(st.to, msg.chat.id, msg.message_id, { reply_markup: kb })
      }
      return render(c.chatId, 'admin', 'Balasan terkirim.', [[b('Panel Admin', 'ad')]], null)
    }
    default:
      state.delete(c.uid)
      return showMenu(c)
  }
}

async function route(c, cmd, a) {
  switch (cmd) {
    case 'noop':
      return
    case 'menu':
      return showMenu(c)
    case 'svc':
      return showPlatforms(c)
    case 'top':
      return showTop(c)
    case 'pl':
      return showCategories(c, a[0], Number(a[1]) || 0)
    case 'ct':
      return showServices(c, Number(a[0]), Number(a[1]) || 0)
    case 's':
      return showService(c, Number(a[0]))
    case 'ord':
      return startOrder(c, Number(a[0]))
    case 'ok':
      return confirmOrder(c)
    case 'find':
      return startSearch(c)
    case 'acc':
      return showAccount(c)
    case 'ref':
      return showReferral(c)
    case 'info':
      return showInfo(c)
    case 'cs':
      return startCs(c)
    case 'dep':
      return showDeposit(c)
    case 'dc':
      return customAmount(c)
    case 'da':
      return pickAmount(c, Number(a[0]))
    case 'dm':
      return pickMethod(c, a[0])
    case 'dgo':
      return createDepositFlow(c)
    case 'dh':
      return showDepositHistory(c, Number(a[0]) || 0)
    case 'dv':
      return showDepositDetail(c, a[0])
    case 'dk': {
      const d = ownDeposit(c, a[0])
      if (d.status !== 'pending') return c.answer(`Status: ${DEPOSIT_STATUS[d.status]}`, true)
      const status = await syncDeposit(d)
      return c.answer(status === 'pending' ? 'Belum ada pembayaran masuk.' : `Status: ${DEPOSIT_STATUS[status] || status}`, true)
    }
    case 'dx': {
      const d = ownDeposit(c, a[0])
      try {
        await zapay('POST', '/batalkantransaksi', { order_id: d.id })
        await closeDeposit(d, 'canceled')
      } catch (e) {
        await syncDeposit(d).catch(() => {})
        throw new UserError('Transaksi tidak bisa dibatalkan, mungkin sudah dibayar atau kedaluwarsa.')
      }
      return
    }
    case 'dsim': {
      if (!zapaySandbox()) throw new UserError('Hanya untuk mode sandbox.')
      const d = ownDeposit(c, a[0])
      if (d.status !== 'pending') throw new UserError(`Deposit ini sudah ${DEPOSIT_STATUS[d.status].toLowerCase()}.`)
      try {
        await zapay('POST', '/simulasi', { order_id: d.id, status: 'paid' })
      } catch (e) {
        await syncDeposit(d).catch(() => {})
        throw new UserError('Simulasi gagal, transaksi sudah tidak pending.')
      }
      c.answer('Simulasi dikirim, tunggu webhook.')
      return
    }
    case 'ol':
      return showOrders(c, Number(a[0]) || 0)
    case 'od':
      return showOrder(c, Number(a[0]))
    case 'or': {
      const o = ownOrder(c, Number(a[0]))
      const res = await smm({ action: 'status', order: o.providerId })
      await applyStatus(o, res)
      c.answer('Status diperbarui')
      return showOrder(c, o.id)
    }
    case 'rf': {
      const o = ownOrder(c, Number(a[0]))
      try {
        await smm({ action: 'refill', order: o.providerId })
      } catch (e) {
        throw new UserError('Refill belum bisa diajukan untuk pesanan ini.')
      }
      return c.answer('Permintaan refill dikirim.', true)
    }
    case 'cn': {
      const o = ownOrder(c, Number(a[0]))
      try {
        const res = await smm({ action: 'cancel', orders: o.providerId })
        const r = Array.isArray(res) ? res[0] : res
        if (!r || (r.cancel && r.cancel.error)) throw new Error('ditolak')
      } catch (e) {
        throw new UserError('Pesanan ini tidak bisa dibatalkan.')
      }
      return c.answer('Permintaan pembatalan dikirim. Saldo kembali otomatis kalau disetujui.', true)
    }
  }
  if (!c.isAdmin) return
  switch (cmd) {
    case 'ad':
      return showAdmin(c)
    case 'ast':
      return showStats(c)
    case 'abal':
      return showBalances(c)
    case 'ap':
      return showPrices(c)
    case 'set':
      return askSetting(c, a[0], a[1])
    case 'au':
      state.set(c.uid, { step: 'adm_uid' })
      return render(c.chatId, 'admin', `${head('👥', 'Kelola user')}\n\nKetik ID Telegram user.`, [[b('✖ Batal', 'ad', 'danger')]], c.msg)
    case 'uf':
      return userAction(c, a[0], a[1])
    case 'ab':
      state.set(c.uid, { step: 'adm_bc' })
      return render(c.chatId, 'admin', `${head('📣', 'Broadcast')}\n\nKirim pesan yang mau disiarkan. Teks, foto, video, atau file semuanya bisa.`, [[b('✖ Batal', 'ad', 'danger')]], c.msg)
    case 'abg': {
      const src = S(c.uid).bc
      if (!src) throw new UserError('Tidak ada pesan broadcast.')
      S(c.uid).bc = null
      runBroadcast(src)
      return render(c.chatId, 'admin', 'Broadcast berjalan di latar belakang. Hasilnya dikirim setelah selesai.', [[b('Panel Admin', 'ad')]], c.msg)
    }
    case 'amt':
      conf().maintenance = !conf().maintenance
      save()
      return showAdmin(c)
    case 'arf': {
      const svc = await loadServices(true)
      c.answer(`${fmt(svc.list.length)} layanan dimuat`, true)
      return
    }
    case 'adb':
      c.answer('Mengirim backup')
      flush()
      return bot.sendDocument(c.chatId, DB_FILE, {}, { contentType: 'application/json' })
    case 'ar':
      state.set(c.uid, { step: 'adm_reply', to: a[0] })
      return render(c.chatId, 'admin', `Ketik balasan untuk <code>${esc(a[0])}</code>. Teks, foto, atau file.`, [[b('Batal', 'ad', 'danger')]], null)
  }
}

function guard(user, chatId) {
  if (user.banned) {
    bot.sendMessage(chatId, 'Akunmu diblokir. Hubungi admin kalau merasa ini keliru.').catch(() => {})
    return true
  }
  if (conf().maintenance && !isAdmin(user.id)) {
    bot.sendMessage(chatId, 'Bot sedang maintenance. Coba lagi nanti.').catch(() => {})
    return true
  }
  return false
}

function failText(e) {
  if (e instanceof UserError) return e.message
  log('error:', e && e.stack ? e.stack : e)
  return 'Terjadi kesalahan, coba lagi sebentar.'
}

bot.on('callback_query', async q => {
  const msg = q.message
  let answered = false
  const answer = (text, alert = false) => {
    if (answered) return
    answered = true
    bot.answerCallbackQuery(q.id, text ? { text: clip(text, 190), show_alert: alert } : {}).catch(() => {})
  }
  if (!msg) return answer()
  const user = getUser(q.from)
  const c = ctxFor(user, msg.chat.id, msg, answer)
  const now = Date.now()
  if (now - (lastAct.get(c.uid) || 0) < 350) return answer()
  lastAct.set(c.uid, now)
  if (guard(user, c.chatId)) return answer()
  const [cmd, ...args] = String(q.data || '').split(':')
  if (cmd !== 'ok' && cmd !== 'dgo') state.delete(c.uid)
  if (cmd === 'ok' || cmd === 'dgo') {
    if (busy.has(c.uid)) return answer('Sedang diproses...')
    busy.add(c.uid)
  }
  try {
    await route(c, cmd, args)
  } catch (e) {
    answer(failText(e), true)
  } finally {
    busy.delete(c.uid)
    answer()
  }
})

bot.on('message', async msg => {
  if (msg.chat.type !== 'private' || !msg.from || msg.from.is_bot) return
  const existed = Boolean(db.users[String(msg.from.id)])
  const user = getUser(msg.from)
  const c = ctxFor(user, msg.chat.id, null)
  try {
    if (guard(user, c.chatId)) return
    const text = (msg.text || '').trim()
    if (text.startsWith('/')) {
      const [raw, param] = text.split(/\s+/)
      const name = raw.split('@')[0].toLowerCase()
      state.delete(c.uid)
      if (name === '/start' && !existed && param && param.startsWith('ref_')) {
        const refId = param.slice(4)
        if (refId !== user.id && db.users[refId]) {
          user.ref = refId
          save()
        }
      }
      if (name === '/saldo') return showAccount(c)
      if (name === '/admin' && c.isAdmin) return showAdmin(c)
      return showMenu(c)
    }
    await handleInput(c, msg)
  } catch (e) {
    bot.sendMessage(c.chatId, failText(e)).catch(() => {})
  }
})

bot.on('polling_error', e => log('polling error:', e.message))

async function main() {
  const me = await bot.getMe()
  botUsername = me.username
  await bot.setMyCommands([
    { command: 'start', description: 'Buka menu utama' },
    { command: 'saldo', description: 'Lihat saldo dan akun' },
    { command: 'batal', description: 'Batalkan input yang sedang berjalan' }
  ])
  const k = String(settings.indosmm.apiKey).trim()
  log(`indosmm key: ${k.slice(0, 4)}...${k.slice(-4)} (${k.length} karakter)`)
  startWebhookServer()
  setInterval(syncOrders, settings.sync.orderSeconds * 1000)
  setInterval(pollDeposits, settings.zapay.pollSeconds * 1000)
  setInterval(checkProviderBalance, 30 * 60 * 1000)
  setTimeout(checkProviderBalance, 10000)
  loadServices().catch(e => log('layanan awal gagal:', e.message))
  log(`bot @${botUsername} aktif, pembayaran ${zapaySandbox() ? 'sandbox' : 'live'}`)
  notifyAdmin(`<b>Bot aktif</b>\n@${esc(botUsername)} | pembayaran ${zapaySandbox() ? 'sandbox' : 'live'}`)
}

main().catch(e => {
  console.error('Gagal start:', e.message)
  process.exit(1)
})