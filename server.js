const express = require('express');
const fs      = require('fs');
const path    = require('path');

const app       = express();
const DATA_FILE = path.join(__dirname, 'data.json');

// ── In-memory store ────────────────────────────────────────
// Loaded once at startup; writes go to Upstash (prod) or data.json (dev).
// All routes stay synchronous — they just read/write the in-memory object.
let DATA = { users: [], restaurants: [], ratings: [] };

function loadData() { return DATA; }

function saveData(data) {
  DATA = data;
  if (process.env.UPSTASH_REDIS_URL) {
    // Fire-and-forget — routes don't wait for this
    fetch(process.env.UPSTASH_REDIS_URL, {
      method:  'POST',
      headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(['SET', 'currybot', JSON.stringify(data)]),
    }).catch(err => console.error('Upstash write error:', err.message));
  } else {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  }
}

// Load persisted data before the server starts accepting requests
async function initStorage() {
  if (process.env.UPSTASH_REDIS_URL) {
    try {
      const res    = await fetch(process.env.UPSTASH_REDIS_URL, {
        method:  'POST',
        headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_TOKEN}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify(['GET', 'currybot']),
      });
      const { result } = await res.json();
      if (result) DATA = JSON.parse(result);
      console.log(`Loaded from Upstash (${DATA.restaurants.length} restaurants)`);
    } catch (e) {
      console.warn('Upstash load failed, starting fresh:', e.message);
    }
  } else {
    if (fs.existsSync(DATA_FILE)) {
      try { DATA = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch {}
    }
    console.log(`Loaded from local file (${DATA.restaurants.length} restaurants)`);
  }
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

app.use(express.json());

// Service worker must be served from root scope with correct headers
app.get('/sw.js', (req, res) => {
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

// manifest.json should never be stale
app.get('/manifest.json', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'manifest.json'));
});

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    // Long-cache for icons and chart lib; no-cache for HTML
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    else if (filePath.match(/\.(png|svg|webp)$/)) res.setHeader('Cache-Control', 'public, max-age=604800');
  },
}));

// ── Users ──────────────────────────────────────────────────
app.get('/api/users', (req, res) => {
  res.json(loadData().users);
});

app.post('/api/users', (req, res) => {
  const data = loadData();
  const { name, emoji } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });

  const existing = data.users.find(u => u.name.toLowerCase() === name.trim().toLowerCase());
  if (existing) return res.json(existing);

  const user = { id: Date.now(), name: name.trim(), emoji: emoji || '🍛', joined: new Date().toISOString() };
  data.users.push(user);
  saveData(data);
  res.json(user);
});

// ── Restaurants ────────────────────────────────────────────
app.get('/api/restaurants', (req, res) => {
  const data = loadData();

  const restaurants = data.restaurants.map(r => {
    const ratings = data.ratings.filter(rt => rt.restaurantId === r.id);
    if (ratings.length === 0) {
      return { ...r, ratings: [], avgScores: null, overallScore: null, ratingCount: 0 };
    }
    const avgScores = {
      poppadoms: avg(ratings.map(rt => rt.poppadoms)),
      main:      avg(ratings.map(rt => rt.main)),
      price:     avg(ratings.map(rt => rt.price)),
      vibe:      avg(ratings.map(rt => rt.vibe)),
      service:   avg(ratings.map(rt => rt.service)),
    };
    const overallScore = Math.round(avg(Object.values(avgScores)) * 10) / 10;
    return { ...r, ratings, avgScores, overallScore, ratingCount: ratings.length };
  });

  restaurants.sort((a, b) => {
    if (a.overallScore === null) return 1;
    if (b.overallScore === null) return -1;
    return b.overallScore - a.overallScore;
  });

  res.json(restaurants);
});

app.post('/api/restaurants', (req, res) => {
  const data = loadData();
  const { name, location, addedBy } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Restaurant name is required' });

  const restaurant = {
    id: Date.now(),
    name: name.trim(),
    location: location || '',
    addedBy: addedBy || '',
    addedAt: new Date().toISOString(),
  };
  data.restaurants.push(restaurant);
  saveData(data);
  res.json(restaurant);
});

// ── Ratings ────────────────────────────────────────────────
app.post('/api/ratings', (req, res) => {
  const data = loadData();
  const { restaurantId, userName, poppadoms, main, price, vibe, service, notes, visitDate } = req.body;

  const existing = data.ratings.find(r => r.restaurantId === restaurantId && r.userName === userName);
  if (existing) {
    return res.status(400).json({ error: `${userName} has already rated this restaurant! One entry per curry house, you greedy naan-grabber 🫓` });
  }

  for (const [key, val] of Object.entries({ poppadoms, main, price, vibe, service })) {
    if (val === undefined || val === null || Number(val) < 0 || Number(val) > 10) {
      return res.status(400).json({ error: `Invalid score for ${key}` });
    }
  }

  const rating = {
    id: Date.now(),
    restaurantId,
    userName,
    poppadoms: Number(poppadoms),
    main:      Number(main),
    price:     Number(price),
    vibe:      Number(vibe),
    service:   Number(service),
    notes:     notes || '',
    visitDate: visitDate || new Date().toISOString().split('T')[0],
    createdAt: new Date().toISOString(),
  };
  data.ratings.push(rating);
  saveData(data);
  res.json(rating);
});

// ── Stats ──────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const data = loadData();

  const raterCounts = {};
  data.ratings.forEach(r => { raterCounts[r.userName] = (raterCounts[r.userName] || 0) + 1; });
  const topRaterEntry = Object.entries(raterCounts).sort((a, b) => b[1] - a[1])[0];

  let mostControversial = null;
  data.restaurants.forEach(r => {
    const ratings = data.ratings.filter(rt => rt.restaurantId === r.id);
    if (ratings.length >= 2) {
      const overalls = ratings.map(rt => (rt.poppadoms + rt.main + rt.price + rt.vibe + rt.service) / 5);
      const mean = avg(overalls);
      const variance = avg(overalls.map(o => Math.pow(o - mean, 2)));
      if (!mostControversial || variance > mostControversial.variance) {
        mostControversial = { id: r.id, name: r.name, variance };
      }
    }
  });

  res.json({
    totalRestaurants: data.restaurants.length,
    totalRatings:     data.ratings.length,
    totalUsers:       data.users.length,
    topRater:         topRaterEntry ? { name: topRaterEntry[0], count: topRaterEntry[1] } : null,
    mostControversial,
  });
});

const PORT = process.env.PORT || 3000;
initStorage().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🍛  CurryBot is serving hot at http://localhost:${PORT}\n`);
  });
});
