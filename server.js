const express = require('express');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');

const app       = express();
const DATA_FILE = path.join(__dirname, 'data.json');

// Admin PIN. When set (Render env var ADMIN_PIN), admin actions need the PIN as well as
// the admin name. When unset, the app falls back to name-only admin (the old behaviour)
// so a deploy never locks the admin out — but anyone choosing the admin name is admin.
const ADMIN_PIN = (process.env.ADMIN_PIN || '').trim();
if (!ADMIN_PIN) console.warn('⚠️  ADMIN_PIN is not set: anyone who picks the admin name can act as admin.');

// ── Storage ────────────────────────────────────────────────
// Prod: Upstash Redis. Dev: data.json plus a photos/ folder.
//   currybot             → JSON blob of users, restaurants, ratings (no images)
//   currybot:photo:<id>  → one image data URI per key
// Keeping photos out of the blob means a rating save only sends a few KB.
const USE_REDIS  = !!process.env.UPSTASH_REDIS_URL;
const MAIN_KEY   = 'currybot';
const PHOTO_DIR  = path.join(__dirname, 'photos');
const photoKey   = id => `currybot:photo:${id}`;

async function redis(...cmd) {
  const res = await fetch(process.env.UPSTASH_REDIS_URL, {
    method:  'POST',
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(cmd),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(`Upstash ${cmd[0]} failed: ${body.error || res.status}`);
  return body.result;
}

// All routes stay synchronous against this in-memory copy.
let DATA = { users: [], restaurants: [], ratings: [] };

function loadData() { return DATA; }

function saveData(data) {
  DATA = data;
  if (USE_REDIS) {
    // Fire-and-forget — routes don't wait for this
    redis('SET', MAIN_KEY, JSON.stringify(data)).catch(err => console.error('Upstash write error:', err.message));
  } else {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  }
}

// Photos are written before anything points at them, so a failed upload never leaves a broken image.
async function storePhoto(dataUri) {
  const id = nextId();
  if (USE_REDIS) await redis('SET', photoKey(id), dataUri);
  else { fs.mkdirSync(PHOTO_DIR, { recursive: true }); fs.writeFileSync(path.join(PHOTO_DIR, `${id}.txt`), dataUri); }
  return id;
}
async function readPhoto(id) {
  if (USE_REDIS) return redis('GET', photoKey(id));
  const f = path.join(PHOTO_DIR, `${id}.txt`);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
}
function deletePhoto(id) {
  if (!id) return;
  if (USE_REDIS) redis('DEL', photoKey(id)).catch(err => console.error('Photo delete failed:', err.message));
  else fs.rm(path.join(PHOTO_DIR, `${id}.txt`), { force: true }, () => {});
}

// ── One-off reset ──────────────────────────────────────────
// Bumping RESET_VERSION wipes everything except the admin on the next start.
// Version 1 (Oct 2026): fresh start before the redesign, keeping Johnny 👑 as admin.
// The old data is copied to a backup key first; the wipe is skipped if that copy fails.
const RESET_VERSION = 1;

async function applyResetIfDue(rawBlob) {
  if (DATA.resetVersion === RESET_VERSION) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (rawBlob) {
    try {
      if (USE_REDIS) await redis('SET', `currybot:backup:${stamp}`, rawBlob);
      else fs.writeFileSync(path.join(__dirname, `data.backup-${stamp}.json`), rawBlob);
      console.log(`Backed up previous data to currybot:backup:${stamp}`);
    } catch (e) {
      console.error('Backup failed, so the reset was NOT applied. Old data kept:', e.message);
      return;
    }
  }
  const old   = (DATA.users || []).find(u => isAdminName(u.name));
  const admin = { id: old ? old.id : nextId(), name: 'Johnny', emoji: '👑', joined: old ? old.joined : new Date().toISOString() };
  DATA = { resetVersion: RESET_VERSION, users: [admin], restaurants: [], ratings: [] };
  if (USE_REDIS) await redis('SET', MAIN_KEY, JSON.stringify(DATA));
  else fs.writeFileSync(DATA_FILE, JSON.stringify(DATA, null, 2));
  console.log('Reset applied: all data cleared except Johnny 👑 (admin)');
}

// Load persisted data before the server starts accepting requests.
// If the database can't be read we stop rather than start empty: starting empty would let the
// next save overwrite the real data. Render restarts the service automatically.
async function initStorage() {
  let raw = null;
  if (USE_REDIS) {
    try {
      raw = await redis('GET', MAIN_KEY);
    } catch (e) {
      console.error('Could not load data from Upstash, refusing to start empty:', e.message);
      process.exit(1);
    }
  } else if (fs.existsSync(DATA_FILE)) {
    raw = fs.readFileSync(DATA_FILE, 'utf8');
  }
  if (raw) {
    try { DATA = JSON.parse(raw); }
    catch (e) { console.error('Stored data is not valid JSON, refusing to start:', e.message); process.exit(1); }
  }
  DATA.users ||= []; DATA.restaurants ||= []; DATA.ratings ||= [];
  await applyResetIfDue(raw);
  console.log(`Loaded ${DATA.restaurants.length} restaurants, ${DATA.users.length} users from ${USE_REDIS ? 'Upstash' : 'local file'}`);
}

// Unique, increasing IDs. Date.now() alone collides when many records are created in the
// same millisecond (bulk import).
let lastId = 0;
function nextId() {
  const now = Date.now();
  lastId = now > lastId ? now : lastId + 1;
  return lastId;
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

const norm = s => String(s || '').trim().toLowerCase();

// The admin is identified by name; with ADMIN_PIN set they must also present the PIN.
function isAdminName(name) {
  return norm(name) === 'johnny';
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function isAdminRequest(req, name) {
  if (!isAdminName(name)) return false;
  if (!ADMIN_PIN) return true;
  return safeEqual(req.get('x-admin-pin') || '', ADMIN_PIN);
}

function findUser(data, name) {
  return data.users.find(u => norm(u.name) === norm(name));
}

const METRIC_KEYS = ['poppadoms', 'main', 'price', 'vibe', 'service'];

// Returns an error string, or null if all five scores are numbers from 0 to 10.
function scoreError(src) {
  for (const key of METRIC_KEYS) {
    const val = src[key];
    const n   = Number(val);
    if (val === undefined || val === null || val === '' || !Number.isFinite(n) || n < 0 || n > 10) {
      return `${key[0].toUpperCase() + key.slice(1)} needs a score from 0 to 10`;
    }
  }
  return null;
}
const roundScore = v => Math.round(Number(v) * 10) / 10;

const MAX_PHOTO_LEN = 6 * 1024 * 1024; // ~6MB data-URI safety cap
// Strict check: the data URI is rendered into an <img src>, so it must be plain base64.
const PHOTO_RE = /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/]+=*$/;
function photoError(image) {
  if (!image || typeof image !== 'string') return 'Photo must be an image';
  if (image.length > MAX_PHOTO_LEN) return 'Photo is too large';
  if (!PHOTO_RE.test(image)) return 'Photo must be an image';
  return null;
}

app.set('trust proxy', 1); // Render sits behind a proxy; needed for per-IP PIN attempt limits
app.use(express.json({ limit: '8mb' }));

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
    // Long-cache for icons; no-cache for HTML
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    else if (filePath.match(/\.(png|svg|webp)$/)) res.setHeader('Cache-Control', 'public, max-age=604800');
  },
}));

// ── Config & admin ─────────────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json({ adminPinRequired: !!ADMIN_PIN });
});

// Simple brute-force guard: 8 wrong PINs per IP locks that IP out for 15 minutes.
const pinFailures = new Map();
app.post('/api/admin/verify', (req, res) => {
  const { name, pin } = req.body || {};
  if (!isAdminName(name)) return res.status(403).json({ error: 'That profile is not an admin' });
  if (!ADMIN_PIN) return res.json({ ok: true });

  const now  = Date.now();
  const rec  = pinFailures.get(req.ip) || { count: 0, until: 0 };
  if (rec.until > now) return res.status(429).json({ error: 'Too many wrong PINs. Try again in 15 minutes.' });

  if (safeEqual(pin || '', ADMIN_PIN)) {
    pinFailures.delete(req.ip);
    return res.json({ ok: true });
  }
  rec.count += 1;
  if (rec.count >= 8) { rec.until = now + 15 * 60 * 1000; rec.count = 0; }
  pinFailures.set(req.ip, rec);
  res.status(401).json({ error: 'Wrong PIN' });
});

// ── Users ──────────────────────────────────────────────────
app.get('/api/users', (req, res) => {
  res.json(loadData().users.map(u => ({ ...u, isAdmin: isAdminName(u.name) })));
});

app.post('/api/users', (req, res) => {
  const data = loadData();
  const { name, emoji } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Enter your name' });

  const existing = findUser(data, name);
  if (existing) return res.json({ ...existing, isAdmin: isAdminName(existing.name) });

  const user = { id: nextId(), name: name.trim(), emoji: emoji || '🍛', joined: new Date().toISOString() };
  data.users.push(user);
  saveData(data);
  res.json({ ...user, isAdmin: isAdminName(user.name) });
});

// ── Restaurants ────────────────────────────────────────────
function summariseRestaurant(data, raw) {
  // Photo IDs are immutable (a new upload gets a new ID), so the URLs can be cached forever.
  const { photoId, groupPhotoId, ...r } = raw;
  if (photoId)      r.photoUrl      = `/photos/${photoId}`;
  if (groupPhotoId) r.groupPhotoUrl = `/photos/${groupPhotoId}`;
  const ratings = data.ratings.filter(rt => rt.restaurantId === r.id)
    // Older ratings stored the text as "notes"; expose it as "summary" everywhere.
    .map(rt => ({ ...rt, summary: rt.summary ?? rt.notes ?? '' }));
  if (ratings.length === 0) {
    return { ...r, ratings: [], avgScores: null, overallScore: null, ratingCount: 0 };
  }
  const avgScores = {};
  for (const k of METRIC_KEYS) avgScores[k] = avg(ratings.map(rt => rt[k]));
  const overallScore = Math.round(avg(Object.values(avgScores)) * 10) / 10;
  return { ...r, ratings, avgScores, overallScore, ratingCount: ratings.length };
}

app.get('/api/restaurants', (req, res) => {
  const data = loadData();
  const restaurants = data.restaurants.map(r => summariseRestaurant(data, r));

  restaurants.sort((a, b) => {
    if (a.overallScore === null && b.overallScore === null) return a.name.localeCompare(b.name);
    if (a.overallScore === null) return 1;
    if (b.overallScore === null) return -1;
    return b.overallScore - a.overallScore;
  });

  res.json(restaurants);
});

// Admin only: name, location and added-by are required; photo is optional.
app.post('/api/restaurants', async (req, res) => {
  const data = loadData();
  const { name, location, addedBy, photo, requestingUser } = req.body;

  if (!isAdminRequest(req, requestingUser)) {
    return res.status(403).json({ error: 'Only the admin can add restaurants' });
  }
  if (!name || !name.trim())         return res.status(400).json({ error: 'Add the restaurant name' });
  if (!location || !location.trim()) return res.status(400).json({ error: 'Add the location' });
  if (!addedBy || !findUser(data, addedBy)) return res.status(400).json({ error: 'Choose who added it' });
  if (data.restaurants.some(r => norm(r.name) === norm(name) && norm(r.location) === norm(location))) {
    return res.status(400).json({ error: `${name.trim()} in ${location.trim()} is already on the board` });
  }
  if (photo) {
    const err = photoError(photo);
    if (err) return res.status(400).json({ error: err });
  }

  let photoId;
  if (photo) {
    try { photoId = await storePhoto(photo); }
    catch (e) { console.error(e.message); return res.status(502).json({ error: "The photo couldn't be saved. Try again, or add it later." }); }
  }

  const restaurant = {
    id: nextId(),
    name: name.trim(),
    location: location.trim(),
    addedBy: findUser(data, addedBy).name,
    addedAt: new Date().toISOString(),
  };
  if (photoId) restaurant.photoId = photoId;
  data.restaurants.push(restaurant);
  saveData(data);
  res.json(summariseRestaurant(data, restaurant));
});

// ── Ratings ────────────────────────────────────────────────
app.post('/api/ratings', (req, res) => {
  const data = loadData();
  const { restaurantId, userName, summary, visitDate, requestingUser } = req.body;

  const restaurant = data.restaurants.find(r => r.id === Number(restaurantId));
  if (!restaurant) return res.status(400).json({ error: 'Choose a restaurant' });

  const user = findUser(data, userName);
  if (!user) return res.status(400).json({ error: 'Choose who is rating' });

  // You rate as yourself; only the admin can enter a rating on someone else's behalf.
  const requester = requestingUser || userName;
  if (norm(requester) !== norm(user.name) && !isAdminRequest(req, requester)) {
    return res.status(403).json({ error: 'You can only rate as yourself' });
  }

  const existing = data.ratings.find(r => r.restaurantId === restaurant.id && norm(r.userName) === norm(user.name));
  if (existing) {
    return res.status(409).json({
      error: `${user.name} has already rated ${restaurant.name}. Edit that rating instead.`,
      existingRatingId: existing.id,
    });
  }

  const sErr = scoreError(req.body);
  if (sErr) return res.status(400).json({ error: sErr });
  if (!summary || !String(summary).trim()) return res.status(400).json({ error: 'Add a summary' });

  const rating = {
    id: nextId(),
    restaurantId: restaurant.id,
    userName: user.name,
    summary:  String(summary).trim(),
    visitDate: visitDate || new Date().toISOString().split('T')[0],
    createdAt: new Date().toISOString(),
  };
  for (const k of METRIC_KEYS) rating[k] = roundScore(req.body[k]);
  data.ratings.push(rating);
  saveData(data);
  res.json(rating);
});

app.put('/api/ratings/:id', (req, res) => {
  const data = loadData();
  const id = Number(req.params.id);
  const rating = data.ratings.find(r => r.id === id);
  if (!rating) return res.status(404).json({ error: 'That rating no longer exists' });

  const { requestingUser, summary, visitDate } = req.body;
  if (norm(requestingUser) !== norm(rating.userName) && !isAdminRequest(req, requestingUser)) {
    return res.status(403).json({ error: 'Only the person who rated, or the admin, can edit this' });
  }

  const sErr = scoreError(req.body);
  if (sErr) return res.status(400).json({ error: sErr });
  if (!summary || !String(summary).trim()) return res.status(400).json({ error: 'Add a summary' });

  for (const k of METRIC_KEYS) rating[k] = roundScore(req.body[k]);
  rating.summary   = String(summary).trim();
  delete rating.notes;
  rating.visitDate = visitDate || rating.visitDate;
  rating.editedAt  = new Date().toISOString();
  rating.editedBy  = (findUser(data, requestingUser) || {}).name || requestingUser;

  saveData(data);
  res.json(rating);
});

app.delete('/api/ratings/:id', (req, res) => {
  const data = loadData();
  const id = Number(req.params.id);
  const idx = data.ratings.findIndex(r => r.id === id);
  if (idx === -1) return res.status(404).json({ error: 'That rating no longer exists' });

  const { requestingUser } = req.body || {};
  const rating = data.ratings[idx];
  if (norm(requestingUser) !== norm(rating.userName) && !isAdminRequest(req, requestingUser)) {
    return res.status(403).json({ error: 'Only the person who rated, or the admin, can delete this' });
  }

  data.ratings.splice(idx, 1);
  saveData(data);
  res.json({ success: true });
});

// ── Restaurant photos ──────────────────────────────────────
// The restaurant photo is admin only; anyone in the crew can add the group photo.
app.patch('/api/restaurants/:id/photo', async (req, res) => {
  const data = loadData();
  const id = Number(req.params.id);
  const restaurant = data.restaurants.find(r => r.id === id);
  if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });

  const { type, image, requestingUser } = req.body;
  if (type !== 'profile' && type !== 'group') {
    return res.status(400).json({ error: 'type must be "profile" or "group"' });
  }
  if (type === 'profile' && !isAdminRequest(req, requestingUser)) {
    return res.status(403).json({ error: 'Only the admin can change the restaurant photo' });
  }
  if (type === 'group' && !findUser(data, requestingUser)) {
    return res.status(403).json({ error: 'Pick your profile before adding a photo' });
  }
  const err = photoError(image);
  if (err) return res.status(400).json({ error: err });

  let newId;
  try { newId = await storePhoto(image); }
  catch (e) { console.error(e.message); return res.status(502).json({ error: "The photo couldn't be saved. Try again." }); }

  const field = type === 'profile' ? 'photoId' : 'groupPhotoId';
  const oldId = restaurant[field];
  restaurant[field] = newId;
  if (type === 'group') restaurant.groupPhotoBy = findUser(data, requestingUser).name;
  saveData(data);
  deletePhoto(oldId);
  res.json(summariseRestaurant(data, restaurant));
});

// Serves a stored photo as a real image file. IDs never change, so browsers cache them for a year.
app.get('/photos/:id', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(404).end();
  try {
    const uri = await readPhoto(req.params.id);
    const m = uri && uri.match(/^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/);
    if (!m) return res.status(404).end();
    res.setHeader('Content-Type', m[1]);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(Buffer.from(m[2], 'base64'));
  } catch (e) {
    console.error('Photo read failed:', e.message);
    res.status(502).end();
  }
});

// ── Bulk import (admin) ────────────────────────────────────
// rows: [{ restaurant, location, date, person, poppadoms, main, price, vibe, service, summary }]
// All rows are validated first; nothing is written if any row is invalid.
// Restaurants and people are matched by name (case-insensitive) and created if missing.
// A person who already rated a restaurant is skipped, never overwritten.
// dryRun: true returns the same report without saving.
app.post('/api/admin/import', (req, res) => {
  const data = loadData();
  const { rows, requestingUser, dryRun } = req.body || {};
  if (!isAdminRequest(req, requestingUser)) return res.status(403).json({ error: 'Only the admin can import' });
  if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'Nothing to import' });
  if (rows.length > 2000) return res.status(400).json({ error: 'Import at most 2,000 rows at a time' });

  const errors = [];
  rows.forEach((row, i) => {
    const line = i + 1;
    if (!row.restaurant || !String(row.restaurant).trim()) errors.push(`Row ${line}: restaurant name is missing`);
    if (!row.person || !String(row.person).trim())         errors.push(`Row ${line}: person is missing`);
    const sErr = scoreError(row);
    if (sErr) errors.push(`Row ${line}: ${sErr}`);
    if (row.date && !/^\d{4}-\d{2}-\d{2}$/.test(String(row.date).trim())) errors.push(`Row ${line}: date must be YYYY-MM-DD`);
  });
  if (errors.length) return res.status(400).json({ error: 'Some rows need fixing', errors });

  const admin = findUser(data, requestingUser);
  const newRestaurants = [], newUsers = [], newRatings = [], skipped = [];
  const restaurantByKey = new Map(data.restaurants.map(r => [norm(r.name), r]));
  const userByKey       = new Map(data.users.map(u => [norm(u.name), u]));
  const rated           = new Set(data.ratings.map(r => `${r.restaurantId}|${norm(r.userName)}`));

  rows.forEach((row, i) => {
    const rName = String(row.restaurant).trim();
    const pName = String(row.person).trim();

    let restaurant = restaurantByKey.get(norm(rName));
    if (!restaurant) {
      restaurant = { id: nextId(), name: rName, location: String(row.location || '').trim(),
                     addedBy: admin ? admin.name : '', addedAt: new Date().toISOString(), imported: true };
      restaurantByKey.set(norm(rName), restaurant);
      newRestaurants.push(restaurant);
    } else if (!restaurant.location && row.location && newRestaurants.includes(restaurant)) {
      restaurant.location = String(row.location).trim();
    }

    let user = userByKey.get(norm(pName));
    if (!user) {
      user = { id: nextId(), name: pName, emoji: '🍛', joined: new Date().toISOString(), imported: true };
      userByKey.set(norm(pName), user);
      newUsers.push(user);
    }

    const key = `${restaurant.id}|${norm(user.name)}`;
    if (rated.has(key)) { skipped.push(`Row ${i + 1}: ${user.name} already rated ${restaurant.name}`); return; }
    rated.add(key);

    const rating = {
      id: nextId(), restaurantId: restaurant.id, userName: user.name,
      summary: String(row.summary || '').trim(),
      visitDate: row.date ? String(row.date).trim() : '',
      createdAt: new Date().toISOString(), imported: true,
    };
    for (const k of METRIC_KEYS) rating[k] = roundScore(row[k]);
    newRatings.push(rating);
  });

  const report = {
    dryRun: !!dryRun,
    restaurantsCreated: newRestaurants.map(r => r.name),
    usersCreated: newUsers.map(u => u.name),
    ratingsCreated: newRatings.length,
    skipped,
  };
  if (!dryRun) {
    data.restaurants.push(...newRestaurants);
    data.users.push(...newUsers);
    data.ratings.push(...newRatings);
    saveData(data);
  }
  res.json(report);
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
  // Bind to all IPv4 interfaces explicitly; Render's port detection expects 0.0.0.0.
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🍛  CurryBot is serving hot at http://localhost:${PORT}\n`);
  });
});
