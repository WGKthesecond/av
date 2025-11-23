// server.js – stocks + GitHub-backed data branch + Discord report proxy
const express   = require('express');
const fs        = require('fs');
const path      = require('path');
const simpleGit = require('simple-git');
const git       = simpleGit();

const app  = express();
app.use(express.json());

// ---------- env + config ----------
const SECRET             = process.env.DEALER_KEY;
const DATAFile           = path.join(__dirname, 'data.json');
const GITHUB_TOKEN       = process.env.GITHUB_TOKEN;      // personal access token
const GITHUB_REPO        = process.env.GITHUB_REPO;       // e.g. "WGKthesecond/av"
const BRANCH             = 'data/PUBLICAPI';              // data-only branch
const REPORT_WEBHOOK_URL = process.env.REPORT_WEBHOOK_URL; // Discord webhook URL

// ---------- stocks structure ----------
// stocks is an ARRAY:
// [
//   {
//     name: "FOO",
//     record: { MON: 0, TUES: 0, WED: 0, THURS: 0, FRI: 0, SAT: 0, SUN: 0 }
//   },
//   ...
// ]
let stocks = [];

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

const DAY_KEYS = ['SUN', 'MON', 'TUES', 'WED', 'THURS', 'FRI', 'SAT'];

function getTodayKey() {
  const now = new Date();
  const idx = now.getUTCDay(); // 0 = SUN ... 6 = SAT
  return DAY_KEYS[idx];
}

function ensureStock(name) {
  let stock = stocks.find(s => s.name === name);
  if (!stock) {
    stock = {
      name,
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
  }
  return stock;
}

// ---------- git helpers ----------
async function gitSetup() {
  try {
    await git.addConfig('user.name', 'render-bot');
    await git.addConfig('user.email', 'render@example.com');

    // Try to checkout the data branch; if it doesn't exist locally, create it
    try {
      await git.checkout(BRANCH);
    } catch {
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
    // Ensure we're on the data branch
    const branches = await git.branchLocal();
    if (!branches.all.includes(BRANCH)) {
      await git.checkoutLocalBranch(BRANCH);
    } else {
      await git.checkout(BRANCH);
    }

    await git.add('data.json');

    // Commit might fail if nothing changed; swallow that
    try {
      await git.commit('chore: update stock data');
    } catch (e) {
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

// ---------- init ----------
load();
gitSetup();

// ---------- routes ----------

// 1) Public read-only snapshot of all stocks
app.get('/stocks', (_req, res) => {
  res.json(stocks);
});

// 2) Trade endpoint: ["get" | "buy" | "sell", <STOCK>, <AMOUNT>?]
//    Uses weekly record format per stock.
app.post('/', (req, res) => {
  if (req.headers['x-dealer-key'] !== SECRET) {
    return res.status(403).json({ error: 'Bad key' });
  }

  const [action, name, amountStr] = req.body || [];
  const amount = parseFloat(amountStr) || 0;

  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'Missing stock name' });
  }

  const stock   = ensureStock(name);
  const dayKey  = getTodayKey();
  const current = stock.record[dayKey] || 0;

  switch (action) {
    case 'get': {
      // Just return the weekly curve
      return res.json({
        name:   stock.name,
        record: stock.record
      });
    }

    case 'buy': {
      stock.record[dayKey] = current + amount;
      save();
      commitAndPush();
      return res.json({
        name:   stock.name,
        record: stock.record
      });
    }

    case 'sell': {
      stock.record[dayKey] = Math.max(0, current - amount);
      save();
      commitAndPush();
      return res.json({
        name:   stock.name,
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

// ---------- start ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Live on ${PORT} | branch ${BRANCH}`);
});
