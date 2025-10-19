// server.js  –  persistent stock table
const express = require('express');
const fs   = require('fs');
const path = require('path');

const app  = express();
app.use(express.json());

const SECRET   = process.env.DEALER_KEY || 'CHANGE_ME';
const DATAFile = path.join(__dirname, 'data.json');

// load table at start
let stocks = {};
try { stocks = JSON.parse(fs.readFileSync(DATAFile, 'utf8')); } catch {}

function save() { fs.writeFileSync(DATAFile, JSON.stringify(stocks, null, 0)); }

function priceOf(name) {
  if (!stocks[name]) { stocks[name] = 100; save(); }
  return stocks[name];
}

// ---------- routes ----------
app.post('/', (req, res) => {
  if (req.headers['x-dealer-key'] !== SECRET)
    return res.status(403).json({ error: 'Bad key' });

  const [action, name, priceStr] = req.body;
  const price = parseFloat(priceStr) || 0;

  switch (action) {
    case 'get':
      return res.json({ price: priceOf(name) });

    case 'buy':
      stocks[name] = priceOf(name) + price;
      save();
      return res.json({ price: stocks[name] });

    case 'sell':
      stocks[name] = Math.max(0.01, priceOf(name) - price);
      save();
      return res.json({ price: stocks[name] });

    default:
      return res.status(400).json({ error: 'Bad action' });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Live on ${PORT}`));
