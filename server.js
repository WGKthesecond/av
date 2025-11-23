// server.js – stocks + GitHub data branch + Discord report proxy

const express   = require('express');
const fs        = require('fs');
const path      = require('path');
const simpleGit = require('simple-git');
const git       = simpleGit();

const app = express();
app.use(express.json());

// ========== ENV / CONFIG ==========
const SECRET             = process.env.DEALER_KEY;          // must match Roblox SEC
const DATAFile           = path.join(__dirname, 'data.json');
const GITHUB_TOKEN       = process.env.GITHUB_TOKEN;        // PAT with repo access
const GITHUB_REPO        = process.env.GITHUB_REPO;         // e.g. "WGKthesecond/av"
const BRANCH             = 'data/PUBLICAPI';                // data-only branch
const REPORT_WEBHOOK_URL = process.env.REPORT_WEBHOOK_URL;  // Discord webhook URL

// ========== STOCK DATA STRUCTURE ==========
//
// stocks is an ARRAY of:
// {
//   name: "AAPL",
//   price: 100,
//   record: { MON: 0, TUES: 0, WED: 0, THURS: 0, FRI: 0, SAT: 0, SUN: 0 }
// }
//
let stocks = [];

const DAY_KEYS = ['SUN', 'MON', 'TUES', 'WED', 'THURS', 'FRI', 'SAT'];

function getTodayKey() {
  const now = new Date();
  return DAY_KEYS[now.getUTCDay()]; // UTC-weekday, 0 = SUN
}

function load() {
  try {
    const raw = fs.readFileSync(DATAFile, 'utf8');
    const parsed = JSON.parse(raw);
    stocks = Array.isArray(parsed) ? parsed : [];
  } catch {
    stocks = [];
  }
}

function save() {
  fs.writeFileSync(DATAFile, JSON.stringify(stocks, null, 0));
}

function ensureRecord(rec) {
  // Make sure record has all 7 keys
  const base = {
    MON: 0,
    TUES: 0,
    WED: 0,
    THURS: 0,
    FRI: 0,
    SAT: 0,
    SUN: 0,
  };
  if (!rec || typeof rec !== 'object') return base;
  for (const k of Object.keys(base)) {
    if (typeof rec[k] !== 'number') {
      rec[k] = 0;
    }
  }
  return rec;
}

function ensureStock(name) {
  let stock = stocks.find(s => s.name === name);
  if (!stock) {
    stock = {
      name,
      price: 100,   // default price
      record: {
        MON: 0,
        TUES: 0,
        WED: 0,
        THURS: 0,
        FRI: 0,
        SAT: 0,
        SUN: 0,
      }
    };
    stocks.push(stock);
  } else {
    if (typeof stock.price !== 'number') {
      stock.price = 100;
    }
    stock.record = ensureRecord(stock.record);
  }
  return stock;
}

// ========== GIT HELPERS ==========
async function gitSetup() {
  try {
    await git.addConfig('user.name', 'render-bot');
    await git.addConfig('user.email', 'render@example.com');

    // Fetch in case the branch exists on remote only
    await git.fetch().catch(() => {});

    try {
      await git.checkout(BRANCH);
    } catch {
      // If local branch doesn't exist yet, create it
      await git.checkoutLocalBranch(BRANCH);
    }
  } catch (e) {
    console.error('gitSetup failed:', e.message);
  }
}

async function commitAndPush() {
  if (!GITHUB_TOKEN || !GITHUB_REPO) return;

  const remote = `https://${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git`;

  try {
    const branches = await git.branchLocal();
    if (!branches.all.includes(BRANCH)) {
      await git.checkoutLocalBranch(BRANCH);
    } else {
      await git.checkout(BRANCH);
    }

    await git.add('data.json');

    try {
      await git.commit('chore: update stock data');
    } catch (e) {
      // Ignore "nothing to commit" errors
      if (!/nothing to commit/i.test(e.message || '')) {
        throw e;
      }
    }

    // Force-push ONLY this branch. main stays untouched.
    await git.push(remote, BRANCH, ['--force', '--set-upstream']);
  } catch (e) {
    console.error('Git push failed', e.message);
  }
}

// ========== INIT ==========
load();
gitSetup();

// ========== ROUTES ==========

// 1) Public read-only snapshot of all stocks (for debugging / external use)
app.get('/stocks', (_req, res) => {
  res.json(stocks);
});

// 2) Trade endpoint (root):
//    Body: ["get" | "buy" | "sell", "<STOCKNAME>", "<AMOUNT>"]
//    Header: x-dealer-key: <SECRET>
app.post('/', (req, res) => {
  if (req.headers['x-dealer-key'] !== SECRET) {
    return res.status(403).json({ error: 'Bad key' });
  }

  const [action, name, amountStr] = req.body || [];
  const amount = parseFloat(amountStr) || 0;

  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'Missing stock name' });
  }

  const stock  = ensureStock(name);
  const dayKey = getTodayKey();

  if (typeof stock.record[dayKey] !== 'number') {
    stock.record[dayKey] = 0;
  }

  switch (action) {
    case 'get': {
      // Just return state as-is
      return res.json({
        name:   stock.name,
        price:  stock.price,
        record: stock.record
      });
    }

    case 'buy': {
      stock.price = (typeof stock.price === 'number' ? stock.price : 100) + amount;
      stock.record[dayKey] = stock.record[dayKey] + amount;

      save();
      commitAndPush();
      return res.json({
        name:   stock.name,
        price:  stock.price,
        record: stock.record
      });
    }

    case 'sell': {
      const basePrice = (typeof stock.price === 'number' ? stock.price : 100);
      stock.price = Math.max(0.01, basePrice - amount);
      stock.record[dayKey] = Math.max(0, stock.record[dayKey] - amount);

      save();
      commitAndPush();
      return res.json({
        name:   stock.name,
        price:  stock.price,
        record: stock.record
      });
    }

    default:
      return res.status(400).json({ error: 'Bad action' });
  }
});

// 3) /report – Roblox → Render → Discord webhook proxy
app.post('/report', async (req, res) => {
  try {
    if (!REPORT_WEBHOOK_URL) {
      console.error('No REPORT_WEBHOOK_URL configured');
      return res.status(500).json({ error: 'Webhook not configured' });
    }

    const {
      clientName,
      reportedPlayerName,
      reason,
      am,
      serverId
    } = req.body || {};

    if (!clientName || !reportedPlayerName) {
      return res.status(400).json({ error: 'Missing clientName or reportedPlayerName' });
    }

    const safeReason = (reason && String(reason).trim()) || 'No reason provided';
    const safeServer = (serverId && String(serverId)) || 'Unknown';

    const fields = [
      { name: 'Reason',      value: safeReason,         inline: true },
      { name: 'Reported By', value: String(clientName), inline: true },
      { name: 'Server ID',   value: safeServer,         inline: true },
    ];

    if (am === true) {
      fields.push({
        name: 'Other',
        value: 'Auto mod can make mistakes.',
        inline: true
      });
    }

    const payload = {
      content: 'Player Report Received: <@&1429477002435629127>',
      embeds: [
        {
          title: `Player Reported: ${reportedPlayerName}`,
          color: 16529667,
          fields
        }
      ]
    };

    // Node 18+ has global fetch; your Render runtime (22.x) supports this
    const resp = await fetch(REPORT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      console.error('Discord webhook failed:', resp.status, text);
      return res.status(500).json({ error: 'Discord webhook failed', status: resp.status });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Error in /report:', err.message || err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ========== START ==========
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Live on ${PORT} | branch ${BRANCH}`);
});

