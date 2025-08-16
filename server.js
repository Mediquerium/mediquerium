// server.js
const express = require("express");
const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "data.json");
const CONFIG_FILE = path.join(__dirname, "config.json");
const ALLOW_RESET = String(process.env.ALLOW_RESET || "false").toLowerCase() === "true";

app.use(express.json());
app.use(express.static(__dirname)); // serve static files (index.html, admin.html, Image.jpg)

// In-process write lock
let lock = Promise.resolve();
function withLock(fn) {
  const next = lock.then(() => fn()).catch((e) => { throw e; });
  lock = next.catch(() => {});
  return next;
}

function loadJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
}

function getConfig() {
  const cfg = loadJSON(CONFIG_FILE, {});
  const cohorts = Array.isArray(cfg.cohorts) && cfg.cohorts.length ? cfg.cohorts : ["Alpha","Beta","Gamma"];
  const perDayLimit = Number.isFinite(cfg.perDayLimit) ? cfg.perDayLimit : 30;
  const perCohortLimit = Number.isFinite(cfg.perCohortLimit) ? cfg.perCohortLimit : 10;
  const allowedDates = Array.isArray(cfg.allowedDates) ? cfg.allowedDates : [];
  const adminPassword = String(cfg.adminPassword || "");
  const smtp = cfg.smtp || {};
  return { cohorts, perDayLimit, perCohortLimit, allowedDates, adminPassword, smtp };
}

function getCountsForDate(data, date, cohorts) {
  const counts = {}; cohorts.forEach(c => counts[c] = 0);
  let total = 0;
  for (const r of data.registrations || []) {
    if (r.date === date && cohorts.includes(r.cohort)) {
      counts[r.cohort] = (counts[r.cohort] || 0) + 1; total++;
    }
  }
  return { counts, total };
}

function getSMTP() {
  const { smtp } = getConfig();
  if (!smtp || !smtp.host || !smtp.user || !smtp.pass) return null;
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port || 587,
    secure: Boolean(smtp.secure),
    auth: { user: smtp.user, pass: smtp.pass }
  });
}

async function sendConfirmationEmail(record) {
  const { smtp } = getConfig();
  if (!smtp || !smtp.user || !smtp.pass) return; // not configured
  const transporter = getSMTP(); if (!transporter) return;
  const subj = `Registration Confirmed - ${record.date} / ${record.cohort}`;
  const body = `Hello ${record.name},

Your registration is confirmed.

Details:
- Date: ${record.date}
- Cohort: ${record.cohort}
- Name: ${record.name}
- Contact: ${record.contact}

Please keep this email for your records.

Regards,
Mediquerium Team`;
  try {
    await transporter.sendMail({
      from: smtp.user,
      to: record.email,
      subject: subj,
      text: body
    });
  } catch (e) {
    console.error("Email send failed:", e.message);
  }
}

// Public APIs
app.get("/api/config", (req, res) => {
  const { cohorts, perDayLimit, perCohortLimit, allowedDates } = getConfig();
  res.json({ cohorts, perDayLimit, perCohortLimit, allowedDates });
});

app.get("/api/slots", (req, res) => {
  const { cohorts, perDayLimit, allowedDates, perCohortLimit } = getConfig();
  const date = String(req.query.date || "");
  if (!allowedDates.includes(date)) {
    return res.json({ ok:true, message:"Date outside allowed window.", counts:Object.fromEntries(cohorts.map(c=>[c,0])), totalRemaining:0 });
  }
  const data = loadJSON(DATA_FILE, { registrations: [] });
  const { counts, total } = getCountsForDate(data, date, cohorts);
  const totalRemaining = Math.max(0, perDayLimit - total);
  res.json({ ok:true, counts, total, totalRemaining, perCohortLimit, perDayLimit });
});

app.post("/api/register", (req, res) => {
  const { cohorts, perDayLimit, perCohortLimit, allowedDates } = getConfig();
  const p = req.body || {};
  const name = String(p.name||"").trim();
  const college = String(p.college||"").trim();
  const year = String(p.year||"").trim();
  const contact = String(p.contact||"").trim();
  const email = String(p.email||"").trim();
  const food = String(p.food||"").trim();
  const date = String(p.date||"").trim();
  const cohort = String(p.cohort||"").trim();

  if (!name || !college || !year || !/^\d{10}$/.test(contact) || !email || !food || !date || !cohort) {
    return res.json({ success:false, message:"Missing/invalid fields." });
  }
  if (!allowedDates.includes(date)) return res.json({ success:false, message:"Selected date is not allowed." });
  if (!cohorts.includes(cohort)) return res.json({ success:false, message:"Invalid cohort." });

  withLock(async () => {
    const data = loadJSON(DATA_FILE, { registrations: [] });

    if (data.registrations.some(r => r.contact === contact && r.date === date)) {
      return res.json({ success:false, message:"You already have a booking for this date." });
    }

    const { counts, total } = getCountsForDate(data, date, cohorts);
    if (total >= perDayLimit) return res.json({ success:false, message:`All ${perDayLimit} slots are booked for this date.` });
    if ((counts[cohort] || 0) >= perCohortLimit) return res.json({ success:false, message:`${cohort} cohort is full for this date.` });

    const record = { ts: new Date().toISOString(), name, college, year, contact, email, food, date, cohort };
    data.registrations.push(record);
    saveJSON(DATA_FILE, data);

    // fire-and-forget email
    sendConfirmationEmail(record).catch(()=>{});

    const after = getCountsForDate(data, date, cohorts);
    const totalRemaining = Math.max(0, perDayLimit - after.total);
    const remainingByCohort = Object.fromEntries(cohorts.map(c => [c, Math.max(0, perCohortLimit - (after.counts[c]||0))]));

    return res.json({ success:true, message:"Booking confirmed.", counts: after.counts, totalRemaining, remainingByCohort });
  }).catch(e => {
    console.error("Register error", e);
    res.status(500).json({ success:false, message:"Server error." });
  });
});

app.post("/api/reset", (req, res) => {
  if (!ALLOW_RESET) return res.status(403).json({ ok:false, message:"Reset is disabled. Set ALLOW_RESET=true to enable." });
  withLock(() => {
    saveJSON(DATA_FILE, { registrations: [] });
    return res.json({ ok:true, message:"All registrations cleared." });
  }).catch(e => res.status(500).json({ ok:false, message:"Server error." }));
});

// --- Admin ---
function adminGuard(req, res, next) {
  const { adminPassword } = getConfig();
  const got = String(req.headers["x-admin-password"] || "");
  if (adminPassword && got === adminPassword) return next();
  return res.status(401).json({ ok:false, message:"Unauthorized" });
}

app.get("/api/admin/data", adminGuard, (req, res) => {
  const data = loadJSON(DATA_FILE, { registrations: [] });
  res.json({ ok:true, registrations: data.registrations || [] });
});

app.get("/api/admin/csv", adminGuard, (req, res) => {
  const { date, cohort } = req.query || {};
  const data = loadJSON(DATA_FILE, { registrations: [] });
  const rows = (data.registrations || []).filter(r => (!date || r.date===date) && (!cohort || r.cohort===cohort));

  let csv = "Timestamp,Name,College,Year,Contact,Email,Food,Date,Cohort\r\n";
  for (const r of rows) {
    const cells = [r.ts, r.name, r.college, r.year, r.contact, r.email, r.food, r.date, r.cohort].map(v => {
      const s = String(v || "").replace(/\"/g,'\"\"');
      return /[\",\r\n]/.test(s) ? `\"${s}\"` : s;
    });
    csv += cells.join(",") + "\r\n";
  }
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=registrations.csv");
  res.send(csv);
});

app.listen(PORT, () => console.log("Server running on port", PORT));
