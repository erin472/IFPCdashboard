'use strict';
const express    = require('express');
const cookieParser = require('cookie-parser');
const crypto     = require('crypto');
const path       = require('path');
const fs         = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Required env vars ────────────────────────────────────────────────────────
const PASSWORD = process.env.PASSWORD;
if (!PASSWORD) {
  console.error('FATAL: PASSWORD environment variable is not set.');
  process.exit(1);
}

const isProduction =
  process.env.RAILWAY_ENVIRONMENT === 'production' ||
  process.env.NODE_ENV === 'production';

// Session secret — random each boot is fine; users just re-login on restart
const SESSION_SECRET = process.env.SESSION_SECRET ||
  crypto.randomBytes(32).toString('hex');

// Pre-compute SHA-256 of the password for server-side comparison
const PW_HASH = crypto.createHash('sha256').update(PASSWORD).digest('hex');

// ─── Token helpers (HMAC-signed, no extra deps) ───────────────────────────────
function signToken(payload) {
  const data = JSON.stringify(payload);
  const sig  = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('hex');
  return Buffer.from(data).toString('base64url') + '.' + sig;
}

function verifyToken(token) {
  try {
    const [b64, sig] = token.split('.');
    const data     = Buffer.from(b64, 'base64url').toString('utf8');
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return null;
    return JSON.parse(data);
  } catch { return null; }
}

function isAuthed(req) {
  const token = req.cookies?.session;
  if (!token) return false;
  const payload = verifyToken(token);
  return payload?.authed === true;
}

// ─── Build dashboard HTML with injected auth/tracking pieces ─────────────────
const POSTHOG_KEY = 'phc_QIgbD8nFuxMwPrURQbXJxKqI1uEwrmWrnorrr5v1oto';

const POSTHOG_SNIPPET = `
<script>
  !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.async=!0,p.src=s.api_host+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+" (stub)"},o="capture identify alias people.set people.set_once set_config register register_once unregister opt_out_capturing has_opted_out_capturing opt_in_capturing reset isFeatureEnabled onFeatureFlags getFeatureFlag getFeatureFlagPayload reloadFeatureFlags group updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures getActiveMatchingSurveys getSurveys".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
  posthog.init('${POSTHOG_KEY}', {api_host:'https://app.posthog.com'});
  (function(){
    var em = localStorage.getItem('app_user_email');
    if (em) { posthog.identify(em); }
  })();
</script>`;

const INJECTED_STYLES = `
<style>
  /* ── Logout button ── */
  .gw-logout-btn {
    position: fixed;
    top: 14px;
    left: 18px;
    z-index: 10000;
    background: rgba(255,255,255,0.18);
    border: 1px solid rgba(255,255,255,0.45);
    color: #fff;
    padding: 5px 14px;
    border-radius: 20px;
    font-size: 0.78rem;
    font-weight: 600;
    cursor: pointer;
    text-decoration: none;
    backdrop-filter: blur(4px);
    font-family: 'Segoe UI', sans-serif;
    letter-spacing: 0.3px;
    transition: background 0.2s;
  }
  .gw-logout-btn:hover { background: rgba(255,255,255,0.32); }

  /* ── Email gate overlay ── */
  #gw-email-gate {
    display: none;
    position: fixed;
    inset: 0;
    z-index: 9999;
    background: rgba(0,0,0,0.55);
    backdrop-filter: blur(6px);
    align-items: center;
    justify-content: center;
  }
  #gw-email-gate.open { display: flex; }
  .gw-email-card {
    background: #fff;
    border-radius: 18px;
    padding: 2.5rem 2.8rem;
    width: 100%;
    max-width: 420px;
    box-shadow: 0 20px 60px rgba(0,0,0,0.25);
    text-align: center;
    font-family: 'Segoe UI', sans-serif;
  }
  .gw-email-card .gw-logo {
    font-size: 2rem;
    margin-bottom: 0.5rem;
  }
  .gw-email-card h2 {
    font-size: 1.25rem;
    font-weight: 700;
    color: #18395B;
    margin-bottom: 0.4rem;
  }
  .gw-email-card p {
    font-size: 0.88rem;
    color: #666;
    margin-bottom: 1.5rem;
  }
  .gw-email-card input {
    width: 100%;
    padding: 0.7rem 1rem;
    border: 2px solid #e2e8f0;
    border-radius: 10px;
    font-size: 0.95rem;
    margin-bottom: 1rem;
    outline: none;
    transition: border 0.2s;
    box-sizing: border-box;
  }
  .gw-email-card input:focus { border-color: #18395B; }
  .gw-email-card .gw-submit {
    width: 100%;
    padding: 0.75rem;
    background: linear-gradient(135deg, #18395B 0%, #00B3F0 100%);
    color: #fff;
    border: none;
    border-radius: 10px;
    font-size: 1rem;
    font-weight: 600;
    cursor: pointer;
    transition: opacity 0.2s;
  }
  .gw-email-card .gw-submit:hover { opacity: 0.88; }
  .gw-email-card .gw-err {
    color: #c62828;
    font-size: 0.82rem;
    margin-top: 0.5rem;
    min-height: 1.2em;
  }
</style>`;

const EMAIL_GATE_HTML = `
<a href="/logout" class="gw-logout-btn">Log out</a>

<div id="gw-email-gate">
  <div class="gw-email-card">
    <div class="gw-logo">🌿</div>
    <h2>Welcome</h2>
    <p>Please enter your work email to continue.</p>
    <input type="email" id="gw-email-input" placeholder="you@company.com" autocomplete="email" />
    <button class="gw-submit" onclick="gwEmailSubmit()">Continue</button>
    <div class="gw-err" id="gw-email-err"></div>
  </div>
</div>

<script>
(function () {
  var EMAIL_KEY = 'app_user_email';
  var stored = localStorage.getItem(EMAIL_KEY);
  if (!stored) {
    document.getElementById('gw-email-gate').classList.add('open');
    setTimeout(function () {
      var inp = document.getElementById('gw-email-input');
      if (inp) inp.focus();
    }, 100);
  }

  window.gwEmailSubmit = function () {
    var inp  = document.getElementById('gw-email-input');
    var err  = document.getElementById('gw-email-err');
    var email = inp.value.trim().toLowerCase();
    err.textContent = '';
    if (!email) { err.textContent = 'Please enter your email.'; inp.focus(); return; }
    var atIdx = email.indexOf('@');
    var dotIdx = email.lastIndexOf('.');
    if (atIdx < 1 || dotIdx < atIdx + 2 || dotIdx >= email.length - 1 || email.indexOf(' ') !== -1) {
      err.textContent = 'Please enter a valid email address.';
      inp.focus(); return;
    }
    localStorage.setItem(EMAIL_KEY, email);
    if (window.posthog) { posthog.identify(email); }
    document.getElementById('gw-email-gate').classList.remove('open');
  };

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && document.getElementById('gw-email-gate').classList.contains('open')) {
      gwEmailSubmit();
    }
  });
})();
</script>`;

// Read and prepare the dashboard HTML once at startup
let rawDashboard = fs.readFileSync(
  path.join(__dirname, 'public', 'dashboard.html'), 'utf8'
);

// 1. Inject PostHog + styles before </head>
rawDashboard = rawDashboard.replace('</head>', POSTHOG_SNIPPET + INJECTED_STYLES + '\n</head>');

// 2. Inject logout button + email gate before </body>
rawDashboard = rawDashboard.replace('</body>', EMAIL_GATE_HTML + '\n</body>');

// ─── Sensor data sync (Guidewheel telemetry: temp/humidity) ──────────────────
const sensorSync = require('./sensorSync');
const SENSOR_FILE = path.join(process.env.DMAIC_DATA_DIR || path.join(__dirname, 'data'), 'sensorData.json');
const sensorStore = sensorSync.createFileStore(SENSOR_FILE);
const PLANT_TZ = process.env.PLANT_TZ || 'America/Chicago';

// servedDashboard = rawDashboard with the current sensor model injected (cached; rebuilt on sync).
let servedDashboard = rawDashboard;
function rebuildServedDashboard(model) {
  try {
    servedDashboard = model
      ? sensorSync.injectSensorData(rawDashboard, sensorSync.toDashboardData(model, PLANT_TZ))
      : rawDashboard;
  } catch (e) {
    console.error(JSON.stringify({ event: 'sensor.inject_error', message: e.message }));
    servedDashboard = rawDashboard;
  }
}
rebuildServedDashboard(sensorStore.read()); // paint persisted cache (or fallback) immediately

const sensorDeps = {
  env: process.env,
  fetchImpl: (url, init) => fetch(url, init),
  now: () => Date.now(),
  store: sensorStore,
  log: (event, payload) => console.log(JSON.stringify({ event, ...payload, at: new Date().toISOString() })),
  onUpdate: (model) => rebuildServedDashboard(model),
};
sensorSync.startScheduler(sensorDeps);

// ─── Login page ───────────────────────────────────────────────────────────────
const LOGIN_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dashboard Access</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(135deg, #18395B 0%, #00B3F0 60%, #EAF6FC 100%);
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    }
    .card {
      background: #fff;
      border-radius: 20px;
      padding: 2.8rem 3rem;
      width: 100%;
      max-width: 400px;
      box-shadow: 0 24px 64px rgba(0,0,0,0.18);
      text-align: center;
    }
    .login-logo-row {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      margin-bottom: 1rem;
    }
    h1 {
      font-size: 1.3rem;
      font-weight: 700;
      color: #0F2A45;
      margin-bottom: 0.4rem;
    }
    p {
      font-size: 0.88rem;
      color: #777;
      margin-bottom: 1.8rem;
    }
    input[type="password"] {
      width: 100%;
      padding: 0.78rem 1rem;
      border: 2px solid #e2e8f0;
      border-radius: 10px;
      font-size: 1rem;
      outline: none;
      transition: border 0.2s;
      margin-bottom: 1rem;
    }
    input[type="password"]:focus { border-color: #18395B; }
    button {
      width: 100%;
      padding: 0.78rem;
      background: linear-gradient(135deg, #18395B 0%, #326194 100%);
      color: #fff;
      border: none;
      border-radius: 10px;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.2s;
    }
    button:hover { opacity: 0.88; }
    button:disabled { opacity: 0.55; cursor: default; }
    .err {
      color: #c62828;
      font-size: 0.82rem;
      margin-top: 0.6rem;
      min-height: 1.2em;
    }
    .spinner {
      display: inline-block;
      width: 14px; height: 14px;
      border: 2px solid rgba(255,255,255,0.4);
      border-top-color: #fff;
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
      margin-right: 6px;
      vertical-align: middle;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="card">
    <div class="login-logo-row">
      <img src="data:image/png;base64,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" alt="IFPC logo" style="height:44px;width:auto;">
      <div style="width:1px;height:36px;background:#ddd;"></div>
      <svg style="height:30px;width:auto;" viewBox="0 0 188.086 50.041" xmlns="http://www.w3.org/2000/svg" xml:space="preserve">
                  <g transform="matrix(1.0992327,0,0,1.0992327,-9.3974125,-8.2720866)">
                    <path fill="#18395B" fill-rule="evenodd" d="m 149.422,48.237 c 0,-2.13 1.727,-3.855 3.855,-3.855 2.13,0 3.855,1.726 3.855,3.855 0,2.129 -1.726,3.855 -3.855,3.855 -2.128,0 -3.855,-1.726 -3.855,-3.855 z m 3.856,4.414 c 2.438,0 4.415,-1.977 4.415,-4.414 0,-2.438 -1.977,-4.414 -4.415,-4.414 -2.438,0 -4.414,1.976 -4.414,4.414 0,2.437 1.976,4.414 4.414,4.414 z"/>
                    <path fill="#18395B" fill-rule="evenodd" d="m 152.246,46.236 h 1.399 c 0.632,0 1.298,0.102 1.298,0.853 0,0.837 -0.7,0.888 -1.366,0.888 h -1.331 z m 3.311,0.887 c 0,-0.973 -0.7,-1.314 -1.759,-1.314 h -2.133 v 4.916 h 0.58 v -2.271 h 1.126 l 1.4,2.271 h 0.717 l -1.502,-2.271 c 0.871,-0.034 1.571,-0.393 1.571,-1.331 z"/>
                    <polygon fill="#18395B" fill-rule="evenodd" points="158.783,8.599 156.427,18.345 151.871,18.345 154.293,8.599"/>
                    <polygon fill="#18395B" fill-rule="evenodd" points="139.017,52.09 139.017,34.527 133.317,8.599 140.537,8.599 143.746,27.136 147.261,8.599 151.75,8.599 146.033,34.527 146.033,52.09"/>
                    <path fill="#18395B" fill-rule="evenodd" d="m 171.925,38.999 v 4.762 c 0,3.056 -1.314,2.834 -2.406,2.834 -1.349,0 -2.458,0 -2.458,-2.783 l -0.051,-6.793 h -6.538 v 8.176 c 0,7.63 4.114,6.862 8.928,6.862 3.874,0 9.421,0.768 9.421,-7.033 v -8.448 c 0,-2.39 -1.246,-4.147 -3.208,-6.11 0,0 -2.186,-1.861 -5.906,-5.582 -2.509,-2.475 -3.056,-4.301 -3.056,-5.991 v -3.567 c 0,-3.038 1.298,-2.799 2.39,-2.799 1.332,0 2.476,0 2.476,2.782 l 0.034,5.462 h 6.554 v -6.008 c 0,-7.629 -4.113,-6.844 -8.943,-6.844 -3.857,0 -9.405,-0.785 -9.405,6.998 v 6.401 c 0,2.373 1.707,4.933 5.77,8.773 -0.002,-0.003 6.398,4.179 6.398,8.908 z"/>
                    <path fill="#18395B" fill-rule="evenodd" d="m 84.125,38.999 v 4.762 c 0,3.056 -1.297,2.834 -2.39,2.834 -1.331,0 -2.475,0 -2.475,-2.783 l -0.018,-6.793 h -6.554 v 8.176 c 0,7.63 4.097,6.862 8.944,6.862 3.858,0 9.422,0.768 9.422,-7.033 v -8.448 c 0,-2.39 -1.263,-4.147 -3.208,-6.11 0,0 -2.185,-1.861 -5.923,-5.582 -2.526,-2.475 -3.039,-4.301 -3.039,-5.991 v -3.567 c 0,-3.038 1.297,-2.799 2.39,-2.799 1.332,0 2.475,0 2.475,2.782 l 0.034,5.462 h 6.554 v -6.008 c 0,-7.629 -4.113,-6.844 -8.961,-6.844 -3.857,0 -9.405,-0.785 -9.405,6.998 v 6.401 c 0,2.373 1.707,4.933 5.786,8.773 0.002,-0.003 6.368,4.179 6.368,8.908 z"/>
                    <path fill="#18395B" fill-rule="evenodd" d="m 56.731,13.071 h 1.501 c 2.595,0 2.304,2.987 2.304,6.025 0,0 0.291,5.94 -2.304,5.94 h -1.501 z m -7.289,39.019 h 7.289 V 30.856 h 1.297 c 2.338,0 2.492,1.11 2.492,3.603 v 9.404 c 0,2.901 0.188,6.811 0.973,8.228 h 7.22 c -0.802,-1.417 -0.717,-5.326 -0.717,-8.228 v -7.681 c 0,-4.302 0.153,-7.579 -3.994,-8.33 3.141,-0.478 4.301,-1.877 4.301,-8.722 0,-9.166 -1.553,-10.531 -9.336,-10.531 H 49.443 V 52.09 Z"/>
                    <polygon fill="#18395B" fill-rule="evenodd" points="130.876,24.951 130.876,30.856 123.366,30.856 123.366,45.826 132.292,45.826 132.292,52.09 116.351,52.09 116.351,8.599 131.934,8.599 131.934,14.368 123.366,14.368 123.366,24.951"/>
                    <polygon fill="#18395B" fill-rule="evenodd" points="45.192,24.951 45.192,30.856 37.682,30.856 37.682,45.826 46.592,45.826 46.592,52.09 30.65,52.09 30.65,8.599 46.268,8.599 46.268,14.368 37.682,14.368 37.682,24.951"/>
                    <polygon fill="#18395B" fill-rule="evenodd" points="112.391,8.599 112.391,52.09 105.375,52.09 105.375,30.856 101.331,30.856 101.331,52.09 94.298,52.09 94.298,8.599 101.331,8.599 101.331,24.883 105.375,24.883 105.375,8.599"/>
                    <polygon fill="#18395B" fill-rule="evenodd" points="27.543,8.599 27.543,52.09 20.528,52.09 20.528,30.856 16.483,30.856 16.483,52.09 9.485,52.09 9.485,8.599 16.483,8.599 16.483,24.883 20.528,24.883 20.528,8.599"/>
                  </g>
                </svg>
    </div>
    <h1>IFPC Plant Runtime Dashboard</h1>
    <p>Enter the access password to continue.</p>
    <input type="password" id="pw" placeholder="Password" autocomplete="current-password" />
    <button id="btn" onclick="doAuth()">Access Dashboard</button>
    <div class="err" id="err"></div>
  </div>

  <script>
    document.getElementById('pw').addEventListener('keydown', function(e) {
      if (e.key === 'Enter') doAuth();
    });

    async function doAuth() {
      var pw  = document.getElementById('pw').value;
      var btn = document.getElementById('btn');
      var err = document.getElementById('err');
      err.textContent = '';
      if (!pw) { err.textContent = 'Please enter the password.'; return; }

      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>Verifying…';

      try {
        var buf  = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pw));
        var hash = Array.from(new Uint8Array(buf))
                       .map(function(b){ return b.toString(16).padStart(2,'0'); }).join('');

        var res = await fetch('/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hash: hash })
        });

        if (res.ok) {
          window.location.href = '/';
        } else {
          err.textContent = 'Incorrect password. Please try again.';
          document.getElementById('pw').value = '';
          document.getElementById('pw').focus();
        }
      } catch(e) {
        err.textContent = 'An error occurred. Please try again.';
      } finally {
        btn.disabled = false;
        btn.textContent = 'Access Dashboard';
      }
    }
  </script>
</body>
</html>`;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cookieParser());
app.use(express.json());

// ─── Executive SSO bypass ─────────────────────────────────────────────────────
// Accept signed tokens from the leadership dashboard so executives can
// click straight in without the plant password.
const EXEC_BYPASS_SECRET = process.env.EXEC_BYPASS_SECRET || '';
const EXEC_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

function verifyExecBypassToken(token) {
  if (!token || !EXEC_BYPASS_SECRET) return null;
  try {
    const [b64, sig] = token.split('.');
    if (!b64 || !sig) return null;
    const data = Buffer.from(b64, 'base64url').toString('utf8');
    const expected = crypto.createHmac('sha256', EXEC_BYPASS_SECRET).update(data).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return null;
    const payload = JSON.parse(data);
    if (!payload.exec) return null;
    if (Date.now() - payload.ts > EXEC_TOKEN_TTL_MS) return null;
    return payload;
  } catch { return null; }
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  // Leadership-dashboard bypass: if a valid exec token is in the URL,
  // mint a session cookie and serve the dashboard directly.
  // (We do NOT redirect here — browsers may drop a SameSite=Strict cookie
  //  on a redirect that originated from a different origin.)
  if (!isAuthed(req) && req.query.token && verifyExecBypassToken(req.query.token)) {
    const token = signToken({ authed: true, ts: Date.now(), via: 'exec' });
    res.cookie('session', token, {
      httpOnly: true,
      secure:   isProduction,
      sameSite: 'lax',
      maxAge:   8 * 60 * 60 * 1000
    });
    res.set('Content-Type', 'text/html; charset=utf-8');
    return res.send(servedDashboard);
  }

  if (isAuthed(req)) {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(servedDashboard);
  } else {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(LOGIN_PAGE);
  }
});

app.post('/auth', (req, res) => {
  const { hash } = req.body || {};
  if (!hash || typeof hash !== 'string') {
    return res.status(400).json({ error: 'Bad request' });
  }

  // Constant-time comparison
  const incoming = Buffer.from(hash.padEnd(64, '0').slice(0, 64), 'hex');
  const expected = Buffer.from(PW_HASH, 'hex');
  const match    = incoming.length === expected.length &&
                   crypto.timingSafeEqual(incoming, expected) &&
                   hash === PW_HASH;

  if (!match) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  const token = signToken({ authed: true, ts: Date.now() });
  res.cookie('session', token, {
    httpOnly: true,
    secure:   isProduction,
    sameSite: 'strict',
    maxAge:   8 * 60 * 60 * 1000  // 8 hours
  });
  res.json({ success: true });
});

app.get('/logout', (req, res) => {
  res.clearCookie('session');
  res.redirect('/');
});

// ─── DMAIC JSON file storage ─────────────────────────────────────────────────
// Railway filesystem is ephemeral — mount a Railway volume at ./data to persist
const DMAIC_DIR  = process.env.DMAIC_DATA_DIR || path.join(__dirname, 'data');
const DMAIC_FILE = path.join(DMAIC_DIR, 'dmaic-entries.json');

if (!fs.existsSync(DMAIC_DIR))  fs.mkdirSync(DMAIC_DIR, { recursive: true });
if (!fs.existsSync(DMAIC_FILE)) fs.writeFileSync(DMAIC_FILE, '[]', 'utf8');

function dmaicRead() {
  try { return JSON.parse(fs.readFileSync(DMAIC_FILE, 'utf8')); }
  catch { return []; }
}
function dmaicWrite(entries) {
  fs.writeFileSync(DMAIC_FILE, JSON.stringify(entries, null, 2), 'utf8');
}

// GET all entries
app.get('/api/dmaic', (req, res) => {
  if (!isAuthed(req)) return res.status(401).json({ error: 'Unauthorized' });
  res.json(dmaicRead());
});

// POST create/update (upsert by id)
app.post('/api/dmaic', (req, res) => {
  if (!isAuthed(req)) return res.status(401).json({ error: 'Unauthorized' });
  const entry = req.body;
  if (!entry || !entry.id) return res.status(400).json({ error: 'Missing id' });
  const entries = dmaicRead();
  const idx = entries.findIndex(e => e.id === entry.id);
  if (idx !== -1) entries[idx] = entry;
  else entries.push(entry);
  dmaicWrite(entries);
  res.json({ success: true });
});

// DELETE by id
app.delete('/api/dmaic/:id', (req, res) => {
  if (!isAuthed(req)) return res.status(401).json({ error: 'Unauthorized' });
  const entries = dmaicRead();
  const filtered = entries.filter(e => e.id !== req.params.id);
  if (filtered.length === entries.length) return res.status(404).json({ error: 'Not found' });
  dmaicWrite(filtered);
  res.json({ success: true });
});

// POST manual sensor refresh — authed session OR SENSOR_REFRESH_TOKEN header
app.post('/api/sensors/refresh', async (req, res) => {
  const token = process.env.SENSOR_REFRESH_TOKEN;
  const viaToken = token && req.get('x-sensor-refresh-token') === token;
  if (!isAuthed(req) && !viaToken) return res.status(401).json({ error: 'Unauthorized' });
  const result = await sensorSync.syncOnce(sensorDeps, 'full');
  const status = result.ok ? 200
    : result.reason === 'no_new_data' ? 200
    : result.reason === 'busy' ? 409
    : result.reason === 'no_creds' ? 503
    : 502; // auth_error, fetch_error, no_data
  res.status(status).json({ ok: result.ok, reason: result.reason, throughMinUtc: result.throughMinUtc, warnings: result.warnings });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} [${isProduction ? 'production' : 'development'}]`);
});
