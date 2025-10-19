// server.js  –  persistent + GitHub-backed stock table (branch data/PUBLICAPI)
const express   = require('express');
const fs        = require('fs');
const path      = require('path');
const simpleGit = require('simple-git');
const git       = simpleGit();

const app  = express();
app.use(express.json());

const SECRET       = process.env.DEALER_KEY;
const DATAFile     = path.join(__dirname, 'data.json');
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;   // personal access token
const GITHUB_REPO  = process.env.GITHUB_REPO;    // user/repo
const BRANCH       = 'data/PUBLICAPI';

// ---------- helpers ----------
let stocks = {};
function load() {
  try { stocks = JSON.parse(fs.readFileSync(DATAFile, 'utf8')); } catch {}
}
function save() {
  fs.writeFileSync(DATAFile, JSON.stringify(stocks, null, 0));
}
async function gitSetup() {
  // make sure we are on the correct branch
  await git.checkout(BRANCH).catch(() => {});
}
async function commitAndPush() {
  if (!GITHUB_TOKEN || !GITHUB_REPO) return;        // silent if not configured
  try {
    await git.add('data.json');
    await git.commit('chore: update prices');
    await git.push(`https://${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git`, BRANCH, ['--set-upstream']);
  } catch (e) { console.error('Git push failed', e.message); }
}

// initialise from disk (or empty) + switch branch
load();
gitSetup();

// ---------- routes ----------
// 1. public read-only snapshot
app.get('/stocks', (_req, res) => res.json(stocks));

// 2. trade endpoint  ["get"|"buy"|"sell", <STOCK>, <PRICE>?]
app.post('/', (req, res) => {
  if (req.headers['x-dealer-key'] !== SECRET)
    return res.status(403).json({ error: 'Bad key' });

  const [action, name, priceStr] = req.body;
  const price = parseFloat(priceStr) || 0;

  switch (action) {
    case 'get':
      if (!stocks[name]) { stocks[name] = 100; save(); commitAndPush(); }
      return res.json({ price: stocks[name] });

    case 'buy':
      stocks[name] = (stocks[name] || 100) + price;
      save(); commitAndPush();
      return res.json({ price: stocks[name] });

    case 'sell':
      stocks[name] = Math.max(0.01, (stocks[name] || 100) - price);
      save(); commitAndPush();
      return res.json({ price: stocks[name] });

    default:
      return res.status(400).json({ error: 'Bad action' });
  }
});

// ---------- start ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Live on ${PORT} | branch ${BRANCH}`));
