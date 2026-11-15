module.exports = {
  botToken: 'ISI TOKEN BOT FATHER',
  adminChatId: 5689892196,
  admins: [],
  dbFile: 'database.json',

  store: {
    name: 'Sosmed Store',
    tagline: 'Followers, like, view dan lainnya. Bayar pakai saldo, proses otomatis.',
    thumbnails: {
      menu: 'assets/menu.jpg',
      services: 'assets/services.jpg',
      deposit: 'assets/deposit.jpg',
      account: 'assets/account.jpg',
      orders: 'assets/orders.jpg',
      info: 'assets/info.jpg',
      help: 'assets/help.jpg',
      referral: 'assets/referral.jpg',
      admin: 'assets/admin.jpg',
      success: 'assets/success.jpg'
    },
    channelUrl: '',
    supportUsername: '',
    buttonStyle: true,
    info: 'Pesanan diproses otomatis setelah saldo terpotong.\nPastikan akun target tidak diprivate dan link sudah benar.\nPesanan yang sudah berjalan tidak bisa diubah linknya.\nJika ada kendala, hubungi CS lewat menu bantuan.'
  },

  indosmm: {
    apiUrl: 'https://indosmm.id/api/v2',
    apiKey: 'APIKEY DARI INDOSMM',
    allowedTypes: ['Default'],
    cacheMinutes: 30,
    lowBalance: 50000
  },

  pricing: {
    markup: { type: 'percent', value: 5 }
  },

  zapay: {
    baseUrl: 'https://zapay.zannmods.net/api/v1',
    apiKey: 'APIKEY ZAPAY',
    feeBearer: 'buyer',
    methods: [
      { id: 'qris', icon: '📱', label: 'QRIS' },
      { id: 'bca', icon: '🏦', label: 'BCA VA' },
      { id: 'bni', icon: '🏦', label: 'BNI VA' },
      { id: 'bri', icon: '🏦', label: 'BRI VA' },
      { id: 'cimb', icon: '🏦', label: 'CIMB VA' },
      { id: 'permata', icon: '🏦', label: 'Permata VA' },
      { id: 'mandiri', icon: '🏦', label: 'Mandiri Bill' }
    ],
    webhookPort: 3000,
    webhookPath: '/zapay/webhook',
    pollSeconds: 45
  },

  deposit: {
    min: 10000,
    max: 5000000,
    presets: [10000, 25000, 50000, 100000, 250000, 500000],
    fee: { type: 'percent', value: 5 },
    maxPending: 3
  },

  referral: {
    percent: 1,
    firstDepositOnly: true
  },

  platforms: [
    { icon: '📸', label: 'Instagram', keys: ['instagram'] },
    { icon: '🎵', label: 'TikTok', keys: ['tiktok'] },
    { icon: '▶️', label: 'YouTube', keys: ['youtube'] },
    { icon: '👍', label: 'Facebook', keys: ['facebook'] },
    { icon: '✈️', label: 'Telegram', keys: ['telegram'] },
    { icon: '🐦', label: 'Twitter / X', keys: ['twitter', 'tweet'] },
    { icon: '🧵', label: 'Threads', keys: ['threads'] },
    { icon: '🎧', label: 'Spotify', keys: ['spotify'] },
    { icon: '🛍', label: 'Shopee', keys: ['shopee'] },
    { icon: '💬', label: 'WhatsApp', keys: ['whatsapp'] },
    { icon: '🌐', label: 'Website', keys: ['website', 'traffic'] }
  ],

  sync: {
    orderSeconds: 60
  },

  pageSize: 8
}