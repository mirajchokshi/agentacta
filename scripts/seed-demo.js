#!/usr/bin/env node
// seed-demo.js — Generate realistic demo JSONL sessions for AgentActa
// Usage: node scripts/seed-demo.js

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEMO_DIR = path.join(__dirname, '..', 'demo');
fs.mkdirSync(DEMO_DIR, { recursive: true });

// Clear existing demo files
for (const f of fs.readdirSync(DEMO_DIR).filter(f => f.endsWith('.jsonl'))) {
  fs.unlinkSync(path.join(DEMO_DIR, f));
}

const uid = () => crypto.randomUUID();
const shortId = () => crypto.randomBytes(4).toString('hex');

// Relative dates in UTC so timeline view works regardless of timezone
function daysAgo(n, hour = 9, minute = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  d.setUTCHours(hour, minute, 0, 0);
  return d;
}

function ts(base, offsetMinutes) {
  return new Date(base.getTime() + offsetMinutes * 60000).toISOString();
}

function sessionLine(id, timestamp, agent = 'main', sessionType = null) {
  const obj = { type: 'session', version: 3, id, timestamp, cwd: '/home/demo/weather-app' };
  if (agent !== 'main') obj.agent = agent;
  if (sessionType) obj.sessionType = sessionType;
  return JSON.stringify(obj);
}

function modelChangeLine(modelId, timestamp, parentId) {
  return JSON.stringify({
    type: 'model_change', id: shortId(), parentId, timestamp,
    provider: 'anthropic', modelId
  });
}

function userMsg(text, timestamp, parentId) {
  const id = shortId();
  return {
    line: JSON.stringify({
      type: 'message', id, parentId, timestamp,
      message: { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() }
    }),
    id
  };
}

function assistantMsg(text, model, timestamp, parentId, usage = null, toolCalls = null) {
  const id = shortId();
  const content = [];
  if (text) content.push({ type: 'text', text });
  if (toolCalls) {
    for (const tc of toolCalls) {
      content.push({ type: 'toolCall', id: tc.id, name: tc.name, arguments: tc.arguments });
    }
  }
  const u = usage || { input: 1200 + Math.floor(Math.random() * 3000), output: 200 + Math.floor(Math.random() * 800), cacheRead: 5000 + Math.floor(Math.random() * 10000), cacheWrite: 100 + Math.floor(Math.random() * 500) };
  u.totalTokens = u.input + u.output + u.cacheRead + u.cacheWrite;
  u.cost = { input: u.input * 0.000003, output: u.output * 0.000015, cacheRead: u.cacheRead * 0.0000003, cacheWrite: u.cacheWrite * 0.00000375, total: 0 };
  u.cost.total = u.cost.input + u.cost.output + u.cost.cacheRead + u.cost.cacheWrite;
  return {
    line: JSON.stringify({
      type: 'message', id, parentId, timestamp,
      message: {
        role: 'assistant', content,
        api: 'anthropic-messages', provider: 'anthropic', model,
        usage: u, stopReason: toolCalls ? 'toolUse' : 'stop', timestamp: Date.now()
      }
    }),
    id
  };
}

function toolResult(toolCallId, toolName, content, timestamp, parentId, isError = false) {
  const id = shortId();
  return {
    line: JSON.stringify({
      type: 'message', id, parentId, timestamp,
      message: {
        role: 'toolResult', toolCallId, toolName,
        content: [{ type: 'text', text: content }],
        isError, timestamp: Date.now()
      }
    }),
    id
  };
}

function writeSession(filename, lines) {
  fs.writeFileSync(path.join(DEMO_DIR, filename), lines.join('\n') + '\n');
}

// ============================================================
// Session 1: Initial project setup
// ============================================================
(() => {
  const sid = uid();
  const base = daysAgo(4, 9, 0);
  const model = 'claude-sonnet-4-20250514';
  const lines = [];
  let pid;

  lines.push(sessionLine(sid, ts(base, 0)));
  pid = shortId(); lines.push(modelChangeLine(model, ts(base, 0), pid));

  let m = userMsg('I want to build a weather app using Node.js and Express. Can you scaffold the project for me? I want to use OpenWeatherMap API.', ts(base, 1), pid);
  lines.push(m.line); pid = m.id;

  // Assistant uses exec to create directory structure
  let tcId = `toolu_${shortId()}${shortId()}`;
  m = assistantMsg("I'll scaffold a Node.js weather app for you. Let me set up the project structure.", model, ts(base, 1.5), pid, null, [
    { id: tcId, name: 'exec', arguments: { command: 'mkdir -p weather-app/{public,src,routes} && cd weather-app && npm init -y' } }
  ]);
  lines.push(m.line); pid = m.id;

  let tr = toolResult(tcId, 'exec', JSON.stringify({ status: 'completed', exitCode: 0, aggregated: 'Wrote to /home/demo/weather-app/package.json\n\n{\n  "name": "weather-app",\n  "version": "1.0.0",\n  "description": "",\n  "main": "index.js",\n  "scripts": {\n    "start": "node server.js",\n    "dev": "nodemon server.js"\n  }\n}' }), ts(base, 1.7), pid);
  lines.push(tr.line); pid = tr.id;

  // Install dependencies
  tcId = `toolu_${shortId()}${shortId()}`;
  m = assistantMsg(null, model, ts(base, 2), pid, null, [
    { id: tcId, name: 'exec', arguments: { command: 'cd weather-app && npm install express dotenv axios' } }
  ]);
  lines.push(m.line); pid = m.id;

  tr = toolResult(tcId, 'exec', JSON.stringify({ status: 'completed', exitCode: 0, aggregated: 'added 58 packages in 3.2s\n\n8 packages are looking for funding\n  run `npm fund` for details' }), ts(base, 2.3), pid);
  lines.push(tr.line); pid = tr.id;

  // Write server.js
  tcId = `toolu_${shortId()}${shortId()}`;
  m = assistantMsg(null, model, ts(base, 2.5), pid, null, [
    { id: tcId, name: 'Write', arguments: { file_path: 'weather-app/server.js', content: `const express = require('express');\nconst path = require('path');\nrequire('dotenv').config();\n\nconst app = express();\nconst PORT = process.env.PORT || 3000;\n\napp.use(express.static(path.join(__dirname, 'public')));\napp.use(express.json());\n\n// Routes\nconst weatherRoutes = require('./routes/weather');\napp.use('/api/weather', weatherRoutes);\n\napp.get('/', (req, res) => {\n  res.sendFile(path.join(__dirname, 'public', 'index.html'));\n});\n\napp.listen(PORT, () => {\n  console.log(\`Weather app running on http://localhost:\${PORT}\`);\n});\n` } }
  ]);
  lines.push(m.line); pid = m.id;

  tr = toolResult(tcId, 'Write', '✅ Successfully wrote to weather-app/server.js (18 lines)', ts(base, 2.7), pid);
  lines.push(tr.line); pid = tr.id;

  // Write .env
  tcId = `toolu_${shortId()}${shortId()}`;
  m = assistantMsg(null, model, ts(base, 3), pid, null, [
    { id: tcId, name: 'Write', arguments: { file_path: 'weather-app/.env', content: 'PORT=3000\nOPENWEATHER_API_KEY=your_api_key_here\n' } }
  ]);
  lines.push(m.line); pid = m.id;

  tr = toolResult(tcId, 'Write', '✅ Successfully wrote to weather-app/.env (2 lines)', ts(base, 3.1), pid);
  lines.push(tr.line); pid = tr.id;

  // Write package.json (updated)
  tcId = `toolu_${shortId()}${shortId()}`;
  m = assistantMsg(null, model, ts(base, 3.3), pid, null, [
    { id: tcId, name: 'Write', arguments: { file_path: 'weather-app/package.json', content: JSON.stringify({ name: 'weather-app', version: '1.0.0', description: 'A weather app powered by OpenWeatherMap API', main: 'server.js', scripts: { start: 'node server.js', dev: 'nodemon server.js' }, dependencies: { express: '^4.18.2', dotenv: '^16.3.1', axios: '^1.6.2' } }, null, 2) } }
  ]);
  lines.push(m.line); pid = m.id;

  tr = toolResult(tcId, 'Write', '✅ Successfully wrote to weather-app/package.json', ts(base, 3.5), pid);
  lines.push(tr.line); pid = tr.id;

  // Write README
  tcId = `toolu_${shortId()}${shortId()}`;
  m = assistantMsg(null, model, ts(base, 3.8), pid, null, [
    { id: tcId, name: 'Write', arguments: { file_path: 'weather-app/README.md', content: '# Weather App\n\nA simple weather application built with Node.js and Express, powered by the OpenWeatherMap API.\n\n## Setup\n\n1. Clone the repository\n2. Run `npm install`\n3. Copy `.env.example` to `.env` and add your OpenWeatherMap API key\n4. Run `npm run dev` for development\n\n## Features\n\n- Current weather by city name\n- Temperature in Celsius and Fahrenheit\n- Weather conditions and icons\n- Responsive design\n' } }
  ]);
  lines.push(m.line); pid = m.id;

  tr = toolResult(tcId, 'Write', '✅ Successfully wrote to weather-app/README.md', ts(base, 4), pid);
  lines.push(tr.line); pid = tr.id;

  m = assistantMsg("The project is scaffolded! Here's what I set up:\n\n```\nweather-app/\n├── server.js          # Express server with static files & API routes\n├── package.json       # Dependencies: express, dotenv, axios\n├── .env               # Environment variables (add your API key)\n├── README.md          # Project documentation\n├── public/            # Frontend files (we'll add these next)\n├── src/               # Source utilities\n└── routes/            # API route handlers\n```\n\nNext steps:\n1. Add your OpenWeatherMap API key to `.env`\n2. I'll create the weather API route handler\n3. Then we'll build the frontend\n\nWant me to continue with the API integration?", model, ts(base, 4.5), pid);
  lines.push(m.line);

  writeSession(`${sid}.jsonl`, lines);
  console.log(`Session 1: ${sid} — Initial project setup (${lines.length} events)`);
})();

// ============================================================
// Session 2: Add OpenWeatherMap integration
// ============================================================
(() => {
  const sid = uid();
  const base = daysAgo(4, 14, 30);
  const model = 'claude-sonnet-4-20250514';
  const lines = [];
  let pid;

  lines.push(sessionLine(sid, ts(base, 0)));
  pid = shortId(); lines.push(modelChangeLine(model, ts(base, 0), pid));

  let m = userMsg("Let's add the OpenWeatherMap API integration. I got my API key: I've put it in .env already.", ts(base, 1), pid);
  lines.push(m.line); pid = m.id;

  // Read .env to verify
  let tcId = `toolu_${shortId()}${shortId()}`;
  m = assistantMsg("Great! Let me check your .env and then build the API client.", model, ts(base, 1.5), pid, null, [
    { id: tcId, name: 'Read', arguments: { file_path: 'weather-app/.env' } }
  ]);
  lines.push(m.line); pid = m.id;

  let tr = toolResult(tcId, 'Read', 'PORT=3000\nOPENWEATHER_API_KEY=ab8f29d1e4c7...redacted', ts(base, 1.7), pid);
  lines.push(tr.line); pid = tr.id;

  // Write the weather API client
  tcId = `toolu_${shortId()}${shortId()}`;
  m = assistantMsg(null, model, ts(base, 2), pid, null, [
    { id: tcId, name: 'Write', arguments: { file_path: 'weather-app/src/weatherClient.js', content: `const axios = require('axios');\n\nconst BASE_URL = 'https://api.openweathermap.org/data/2.5';\n\nasync function getCurrentWeather(city) {\n  const apiKey = process.env.OPENWEATHER_API_KEY;\n  if (!apiKey) throw new Error('OPENWEATHER_API_KEY not set');\n\n  const response = await axios.get(\`\${BASE_URL}/weather\`, {\n    params: {\n      q: city,\n      appid: apiKey,\n      units: 'metric'\n    },\n    timeout: 5000\n  });\n\n  const data = response.data;\n  return {\n    city: data.name,\n    country: data.sys.country,\n    temp: data.main.temp,\n    feelsLike: data.main.feels_like,\n    humidity: data.main.humidity,\n    description: data.weather[0].description,\n    icon: data.weather[0].icon,\n    windSpeed: data.wind.speed\n  };\n}\n\nmodule.exports = { getCurrentWeather };\n` } }
  ]);
  lines.push(m.line); pid = m.id;

  tr = toolResult(tcId, 'Write', '✅ Successfully wrote to weather-app/src/weatherClient.js (32 lines)', ts(base, 2.2), pid);
  lines.push(tr.line); pid = tr.id;

  // Write route handler
  tcId = `toolu_${shortId()}${shortId()}`;
  m = assistantMsg(null, model, ts(base, 2.5), pid, null, [
    { id: tcId, name: 'Write', arguments: { file_path: 'weather-app/routes/weather.js', content: `const express = require('express');\nconst router = express.Router();\nconst { getCurrentWeather } = require('../src/weatherClient');\n\nrouter.get('/:city', async (req, res) => {\n  try {\n    const weather = await getCurrentWeather(req.params.city);\n    res.json(weather);\n  } catch (err) {\n    if (err.response && err.response.status === 404) {\n      return res.status(404).json({ error: 'City not found' });\n    }\n    console.error('Weather API error:', err.message);\n    res.status(500).json({ error: 'Failed to fetch weather data' });\n  }\n});\n\nmodule.exports = router;\n` } }
  ]);
  lines.push(m.line); pid = m.id;

  tr = toolResult(tcId, 'Write', '✅ Successfully wrote to weather-app/routes/weather.js (18 lines)', ts(base, 2.7), pid);
  lines.push(tr.line); pid = tr.id;

  // Test it
  tcId = `toolu_${shortId()}${shortId()}`;
  m = assistantMsg("Let me test the API endpoint.", model, ts(base, 3), pid, null, [
    { id: tcId, name: 'exec', arguments: { command: 'cd weather-app && timeout 5 node -e "require(\'dotenv\').config(); const {getCurrentWeather} = require(\'./src/weatherClient\'); getCurrentWeather(\'London\').then(d => console.log(JSON.stringify(d, null, 2))).catch(e => console.error(e.message))"' } }
  ]);
  lines.push(m.line); pid = m.id;

  tr = toolResult(tcId, 'exec', JSON.stringify({ status: 'completed', exitCode: 0, aggregated: '{\n  "city": "London",\n  "country": "GB",\n  "temp": 8.3,\n  "feelsLike": 5.1,\n  "humidity": 76,\n  "description": "overcast clouds",\n  "icon": "04d",\n  "windSpeed": 5.2\n}' }), ts(base, 3.5), pid);
  lines.push(tr.line); pid = tr.id;

  m = assistantMsg("The API integration is working. Here's a summary of what was built:\n\n- **`src/weatherClient.js`** — Axios-based client that calls OpenWeatherMap's current weather endpoint, returns a clean object with city, temp, humidity, description, wind speed, and icon code\n- **`routes/weather.js`** — Express route handler at `/api/weather/:city` with proper error handling for 404 (city not found) and 500 (API failures)\n\nI tested it with London and got back valid data. The API returns metric units by default.", model, ts(base, 4), pid);
  lines.push(m.line); pid = m.id;

  m = userMsg("Nice! But can you add retry logic? Sometimes the API is flaky.", ts(base, 8), pid);
  lines.push(m.line); pid = m.id;

  // Search for best practices
  tcId = `toolu_${shortId()}${shortId()}`;
  m = assistantMsg("Good call. Let me check the best approach for axios retry.", model, ts(base, 8.5), pid, null, [
    { id: tcId, name: 'web_search', arguments: { query: 'axios retry logic best practices node.js exponential backoff' } }
  ]);
  lines.push(m.line); pid = m.id;

  tr = toolResult(tcId, 'web_search', JSON.stringify([
    { title: 'Implementing Retry Logic with Axios', url: 'https://blog.example.com/axios-retry', snippet: 'Use axios-retry or implement custom interceptors with exponential backoff...' },
    { title: 'axios-retry - npm', url: 'https://npmjs.com/package/axios-retry', snippet: 'Axios plugin that intercepts failed requests and retries them...' }
  ]), ts(base, 8.8), pid);
  lines.push(tr.line); pid = tr.id;

  // Install axios-retry
  tcId = `toolu_${shortId()}${shortId()}`;
  m = assistantMsg(null, model, ts(base, 9), pid, null, [
    { id: tcId, name: 'exec', arguments: { command: 'cd weather-app && npm install axios-retry' } }
  ]);
  lines.push(m.line); pid = m.id;

  tr = toolResult(tcId, 'exec', JSON.stringify({ status: 'completed', exitCode: 0, aggregated: 'added 1 package in 0.8s' }), ts(base, 9.3), pid);
  lines.push(tr.line); pid = tr.id;

  // Edit weatherClient.js to add retry
  tcId = `toolu_${shortId()}${shortId()}`;
  m = assistantMsg(null, model, ts(base, 9.5), pid, null, [
    { id: tcId, name: 'Edit', arguments: { file_path: 'weather-app/src/weatherClient.js', old_string: "const axios = require('axios');", new_string: "const axios = require('axios');\nconst axiosRetry = require('axios-retry');\n\nconst client = axios.create({ timeout: 5000 });\naxiosRetry(client, {\n  retries: 3,\n  retryDelay: axiosRetry.exponentialDelay,\n  retryCondition: (error) =>\n    axiosRetry.isNetworkOrIdempotentRequestError(error) ||\n    error.code === 'ECONNABORTED'\n});" } }
  ]);
  lines.push(m.line); pid = m.id;

  tr = toolResult(tcId, 'Edit', '✅ Applied edit to weather-app/src/weatherClient.js', ts(base, 9.7), pid);
  lines.push(tr.line); pid = tr.id;

  // Edit to use client instead of axios
  tcId = `toolu_${shortId()}${shortId()}`;
  m = assistantMsg(null, model, ts(base, 10), pid, null, [
    { id: tcId, name: 'Edit', arguments: { file_path: 'weather-app/src/weatherClient.js', old_string: 'const response = await axios.get', new_string: 'const response = await client.get' } }
  ]);
  lines.push(m.line); pid = m.id;

  tr = toolResult(tcId, 'Edit', '✅ Applied edit to weather-app/src/weatherClient.js', ts(base, 10.2), pid);
  lines.push(tr.line); pid = tr.id;

  m = assistantMsg("Done! I've added `axios-retry` with:\n\n- **3 retries** with exponential backoff\n- Retries on network errors and timeouts (`ECONNABORTED`)\n- Uses a dedicated axios instance so it doesn't affect other HTTP calls\n\nThe retry delays will be ~100ms, ~200ms, ~400ms. Should handle flaky API responses well.", model, ts(base, 10.5), pid);
  lines.push(m.line);

  writeSession(`${sid}.jsonl`, lines);
  console.log(`Session 2: ${sid} — OpenWeatherMap integration (${lines.length} events)`);
})();

// ============================================================
// Session 3: Build the frontend
// ============================================================
(() => {
  const sid = uid();
  const base = daysAgo(3, 10, 0);
  const model = 'claude-sonnet-4-20250514';
  const lines = [];
  let pid;

  lines.push(sessionLine(sid, ts(base, 0)));
  pid = shortId(); lines.push(modelChangeLine(model, ts(base, 0), pid));

  let m = userMsg("Now let's build the frontend. I want a clean, modern design — search bar at the top, weather card below. Dark mode.", ts(base, 1), pid);
  lines.push(m.line); pid = m.id;

  // Write HTML
  let tcId = `toolu_${shortId()}${shortId()}`;
  m = assistantMsg("I'll create a sleek dark-mode weather UI. Starting with the HTML.", model, ts(base, 2), pid, null, [
    { id: tcId, name: 'Write', arguments: { file_path: 'weather-app/public/index.html', content: `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>Weather App</title>\n  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n  <div class="container">\n    <h1>🌤 Weather</h1>\n    <form id="search-form">\n      <input type="text" id="city-input" placeholder="Enter city name..." autocomplete="off">\n      <button type="submit">Search</button>\n    </form>\n    <div id="weather-card" class="hidden">\n      <div class="weather-header">\n        <img id="weather-icon" src="" alt="weather icon">\n        <div>\n          <h2 id="city-name"></h2>\n          <p id="country"></p>\n        </div>\n      </div>\n      <div class="temp-display">\n        <span id="temperature"></span>\n        <span class="unit">°C</span>\n      </div>\n      <p id="description"></p>\n      <div class="details">\n        <div><span>Feels like</span><span id="feels-like"></span></div>\n        <div><span>Humidity</span><span id="humidity"></span></div>\n        <div><span>Wind</span><span id="wind"></span></div>\n      </div>\n    </div>\n    <div id="error" class="hidden"></div>\n  </div>\n  <script src="app.js"></script>\n</body>\n</html>` } }
  ]);
  lines.push(m.line); pid = m.id;

  let tr = toolResult(tcId, 'Write', '✅ Successfully wrote to weather-app/public/index.html (40 lines)', ts(base, 2.3), pid);
  lines.push(tr.line); pid = tr.id;

  // Write CSS
  tcId = `toolu_${shortId()}${shortId()}`;
  m = assistantMsg(null, model, ts(base, 2.5), pid, null, [
    { id: tcId, name: 'Write', arguments: { file_path: 'weather-app/public/style.css', content: `* { margin: 0; padding: 0; box-sizing: border-box; }\n\nbody {\n  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;\n  background: #1a1a2e;\n  color: #e0e0e0;\n  min-height: 100vh;\n  display: flex;\n  justify-content: center;\n  align-items: flex-start;\n  padding-top: 10vh;\n}\n\n.container {\n  width: 100%;\n  max-width: 480px;\n  padding: 2rem;\n}\n\nh1 {\n  font-size: 2rem;\n  margin-bottom: 1.5rem;\n  text-align: center;\n}\n\n#search-form {\n  display: flex;\n  gap: 0.5rem;\n  margin-bottom: 2rem;\n}\n\n#city-input {\n  flex: 1;\n  padding: 0.75rem 1rem;\n  border: 1px solid #333;\n  border-radius: 8px;\n  background: #16213e;\n  color: #fff;\n  font-size: 1rem;\n}\n\nbutton {\n  padding: 0.75rem 1.5rem;\n  background: #0f3460;\n  color: #fff;\n  border: none;\n  border-radius: 8px;\n  cursor: pointer;\n  font-size: 1rem;\n  transition: background 0.2s;\n}\n\nbutton:hover { background: #1a5276; }\n\n#weather-card {\n  background: #16213e;\n  border-radius: 16px;\n  padding: 2rem;\n  text-align: center;\n}\n\n.weather-header {\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  gap: 1rem;\n  margin-bottom: 1rem;\n}\n\n#weather-icon { width: 64px; height: 64px; }\n\n.temp-display {\n  font-size: 4rem;\n  font-weight: 700;\n  margin: 1rem 0;\n}\n\n.unit { font-size: 1.5rem; opacity: 0.6; }\n\n#description {\n  text-transform: capitalize;\n  opacity: 0.8;\n  margin-bottom: 1.5rem;\n}\n\n.details {\n  display: grid;\n  grid-template-columns: repeat(3, 1fr);\n  gap: 1rem;\n  border-top: 1px solid #333;\n  padding-top: 1rem;\n}\n\n.details div {\n  display: flex;\n  flex-direction: column;\n  gap: 0.25rem;\n}\n\n.details span:first-child {\n  font-size: 0.75rem;\n  text-transform: uppercase;\n  opacity: 0.5;\n}\n\n.hidden { display: none; }\n\n#error {\n  text-align: center;\n  color: #e74c3c;\n  padding: 1rem;\n}` } }
  ]);
  lines.push(m.line); pid = m.id;

  tr = toolResult(tcId, 'Write', '✅ Successfully wrote to weather-app/public/style.css (96 lines)', ts(base, 2.8), pid);
  lines.push(tr.line); pid = tr.id;

  // Write JS
  tcId = `toolu_${shortId()}${shortId()}`;
  m = assistantMsg(null, model, ts(base, 3), pid, null, [
    { id: tcId, name: 'Write', arguments: { file_path: 'weather-app/public/app.js', content: `const form = document.getElementById('search-form');\nconst input = document.getElementById('city-input');\nconst card = document.getElementById('weather-card');\nconst error = document.getElementById('error');\n\nform.addEventListener('submit', async (e) => {\n  e.preventDefault();\n  const city = input.value.trim();\n  if (!city) return;\n\n  error.classList.add('hidden');\n  card.classList.add('hidden');\n\n  try {\n    const res = await fetch(\`/api/weather/\${encodeURIComponent(city)}\`);\n    if (!res.ok) {\n      const data = await res.json();\n      throw new Error(data.error || 'Failed to fetch weather');\n    }\n    const data = await res.json();\n    renderWeather(data);\n  } catch (err) {\n    error.textContent = err.message;\n    error.classList.remove('hidden');\n  }\n});\n\nfunction renderWeather(data) {\n  document.getElementById('city-name').textContent = data.city;\n  document.getElementById('country').textContent = data.country;\n  document.getElementById('temperature').textContent = Math.round(data.temp);\n  document.getElementById('description').textContent = data.description;\n  document.getElementById('feels-like').textContent = Math.round(data.feelsLike) + '°C';\n  document.getElementById('humidity').textContent = data.humidity + '%';\n  document.getElementById('wind').textContent = data.windSpeed + ' m/s';\n  document.getElementById('weather-icon').src =\n    \`https://openweathermap.org/img/wn/\${data.icon}@2x.png\`;\n  card.classList.remove('hidden');\n}` } }
  ]);
  lines.push(m.line); pid = m.id;

  tr = toolResult(tcId, 'Write', '✅ Successfully wrote to weather-app/public/app.js (40 lines)', ts(base, 3.3), pid);
  lines.push(tr.line); pid = tr.id;

  m = assistantMsg("Here's the frontend — three files:\n\n- **`public/index.html`** — Semantic HTML with search form and weather card\n- **`public/style.css`** — Dark mode with `#1a1a2e` background, rounded cards, grid layout for details\n- **`public/app.js`** — Fetch-based API client with error handling\n\nThe design is minimal: search bar at top, weather card below with icon, temperature, description, and three detail columns (feels like, humidity, wind).\n\nWant to preview it?", model, ts(base, 4), pid);
  lines.push(m.line); pid = m.id;

  m = userMsg("Looks good but can you make the search bar have a subtle animation? Maybe a glow effect on focus.", ts(base, 12), pid);
  lines.push(m.line); pid = m.id;

  tcId = `toolu_${shortId()}${shortId()}`;
  m = assistantMsg(null, model, ts(base, 12.5), pid, null, [
    { id: tcId, name: 'Edit', arguments: { file_path: 'weather-app/public/style.css', old_string: '#city-input {\n  flex: 1;\n  padding: 0.75rem 1rem;\n  border: 1px solid #333;\n  border-radius: 8px;\n  background: #16213e;\n  color: #fff;\n  font-size: 1rem;\n}', new_string: '#city-input {\n  flex: 1;\n  padding: 0.75rem 1rem;\n  border: 1px solid #333;\n  border-radius: 8px;\n  background: #16213e;\n  color: #fff;\n  font-size: 1rem;\n  transition: border-color 0.3s, box-shadow 0.3s;\n}\n\n#city-input:focus {\n  outline: none;\n  border-color: #0f3460;\n  box-shadow: 0 0 0 3px rgba(15, 52, 96, 0.3), 0 0 20px rgba(15, 52, 96, 0.15);\n}' } }
  ]);
  lines.push(m.line); pid = m.id;

  tr = toolResult(tcId, 'Edit', '✅ Applied edit to weather-app/public/style.css', ts(base, 12.7), pid);
  lines.push(tr.line); pid = tr.id;

  m = assistantMsg("Added a focus glow effect — when you click on the search input, it gets a soft blue box-shadow that fades in over 300ms. Subtle but clean.", model, ts(base, 13), pid);
  lines.push(m.line);

  writeSession(`${sid}.jsonl`, lines);
  console.log(`Session 3: ${sid} — Build the frontend (${lines.length} events)`);
})();

// ============================================================
// Session 4: Debug API timeout issue (uses claude-opus-4-6)
// ============================================================
(() => {
  const sid = uid();
  const base = daysAgo(2, 16, 0);
  const model = 'claude-opus-4-6';
  const lines = [];
  let pid;

  lines.push(sessionLine(sid, ts(base, 0)));
  pid = shortId(); lines.push(modelChangeLine(model, ts(base, 0), pid));

  let m = userMsg("The app is timing out in production. Users are getting 500 errors when searching for weather. It was working fine yesterday. Can you debug this?", ts(base, 1), pid);
  lines.push(m.line); pid = m.id;

  // Check logs
  let tcId = `toolu_${shortId()}${shortId()}`;
  m = assistantMsg("Let me investigate. I'll check the server logs first.", model, ts(base, 1.5), pid, null, [
    { id: tcId, name: 'exec', arguments: { command: 'cd weather-app && tail -50 /var/log/weather-app/error.log 2>/dev/null || pm2 logs weather-app --err --lines 30 --nostream 2>/dev/null || echo "Checking stdout..."' } }
  ]);
  lines.push(m.line); pid = m.id;

  let tr = toolResult(tcId, 'exec', JSON.stringify({ status: 'completed', exitCode: 0, aggregated: '2026-02-12T15:42:11Z Weather API error: timeout of 5000ms exceeded\n2026-02-12T15:43:22Z Weather API error: timeout of 5000ms exceeded\n2026-02-12T15:44:08Z Weather API error: connect ETIMEDOUT 95.217.228.33:443\n2026-02-12T15:45:55Z Weather API error: timeout of 5000ms exceeded\n2026-02-12T15:47:12Z Weather API error: timeout of 5000ms exceeded\n2026-02-12T15:48:33Z Weather API error: connect ETIMEDOUT 95.217.228.33:443\n2026-02-12T15:51:01Z Weather API error: timeout of 5000ms exceeded' }), ts(base, 1.8), pid);
  lines.push(tr.line); pid = tr.id;

  // Check if OpenWeatherMap is down
  tcId = `toolu_${shortId()}${shortId()}`;
  m = assistantMsg("Lots of timeouts hitting `95.217.228.33:443` — that's OpenWeatherMap. Let me check if their API is having issues.", model, ts(base, 2), pid, null, [
    { id: tcId, name: 'web_search', arguments: { query: 'OpenWeatherMap API down status February 2026' } }
  ]);
  lines.push(m.line); pid = m.id;

  tr = toolResult(tcId, 'web_search', JSON.stringify([
    { title: 'OpenWeatherMap Status — Degraded Performance', url: 'https://status.openweathermap.org', snippet: 'We are experiencing degraded performance on our free tier API endpoints. Premium endpoints are unaffected.' },
    { title: 'OpenWeatherMap API slowdowns reported', url: 'https://community.openweathermap.org/t/12345', snippet: 'Multiple users reporting timeouts on /data/2.5/weather endpoint since Feb 12...' }
  ]), ts(base, 2.3), pid);
  lines.push(tr.line); pid = tr.id;

  // Read current code
  tcId = `toolu_${shortId()}${shortId()}`;
  m = assistantMsg("OpenWeatherMap is having degraded performance on free tier. Let me check our current timeout and retry config.", model, ts(base, 2.5), pid, null, [
    { id: tcId, name: 'Read', arguments: { file_path: 'weather-app/src/weatherClient.js' } }
  ]);
  lines.push(m.line); pid = m.id;

  tr = toolResult(tcId, 'Read', `const axios = require('axios');\nconst axiosRetry = require('axios-retry');\n\nconst client = axios.create({ timeout: 5000 });\naxiosRetry(client, {\n  retries: 3,\n  retryDelay: axiosRetry.exponentialDelay,\n  retryCondition: (error) =>\n    axiosRetry.isNetworkOrIdempotentRequestError(error) ||\n    error.code === 'ECONNABORTED'\n});\n\nconst BASE_URL = 'https://api.openweathermap.org/data/2.5';\n\nasync function getCurrentWeather(city) {\n  const apiKey = process.env.OPENWEATHER_API_KEY;\n  if (!apiKey) throw new Error('OPENWEATHER_API_KEY not set');\n\n  const response = await client.get(\`\${BASE_URL}/weather\`, {\n    params: { q: city, appid: apiKey, units: 'metric' }\n  });\n\n  const data = response.data;\n  return {\n    city: data.name, country: data.sys.country,\n    temp: data.main.temp, feelsLike: data.main.feels_like,\n    humidity: data.main.humidity, description: data.weather[0].description,\n    icon: data.weather[0].icon, windSpeed: data.wind.speed\n  };\n}\n\nmodule.exports = { getCurrentWeather };`, ts(base, 2.7), pid);
  lines.push(tr.line); pid = tr.id;

  // Add caching and increase timeout
  tcId = `toolu_${shortId()}${shortId()}`;
  m = assistantMsg("The issue is that with OWM degraded, our 5s timeout + 3 retries means users wait up to 20 seconds before getting a 500. I'll add in-memory caching and a faster fallback.", model, ts(base, 3), pid, null, [
    { id: tcId, name: 'Edit', arguments: { file_path: 'weather-app/src/weatherClient.js', old_string: "const BASE_URL = 'https://api.openweathermap.org/data/2.5';", new_string: "const BASE_URL = 'https://api.openweathermap.org/data/2.5';\n\n// Simple in-memory cache (TTL: 10 minutes)\nconst cache = new Map();\nconst CACHE_TTL = 10 * 60 * 1000;\n\nfunction getCached(key) {\n  const entry = cache.get(key);\n  if (!entry) return null;\n  if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(key); return null; }\n  return entry.data;\n}\n\nfunction setCache(key, data) {\n  cache.set(key, { data, ts: Date.now() });\n  // Evict old entries if cache grows too large\n  if (cache.size > 500) {\n    const oldest = cache.keys().next().value;\n    cache.delete(oldest);\n  }\n}" } }
  ]);
  lines.push(m.line); pid = m.id;

  tr = toolResult(tcId, 'Edit', '✅ Applied edit to weather-app/src/weatherClient.js', ts(base, 3.2), pid);
  lines.push(tr.line); pid = tr.id;

  // Update getCurrentWeather to use cache
  tcId = `toolu_${shortId()}${shortId()}`;
  m = assistantMsg(null, model, ts(base, 3.5), pid, null, [
    { id: tcId, name: 'Edit', arguments: { file_path: 'weather-app/src/weatherClient.js', old_string: "async function getCurrentWeather(city) {\n  const apiKey = process.env.OPENWEATHER_API_KEY;\n  if (!apiKey) throw new Error('OPENWEATHER_API_KEY not set');", new_string: "async function getCurrentWeather(city) {\n  const cacheKey = city.toLowerCase().trim();\n  const cached = getCached(cacheKey);\n  if (cached) return { ...cached, fromCache: true };\n\n  const apiKey = process.env.OPENWEATHER_API_KEY;\n  if (!apiKey) throw new Error('OPENWEATHER_API_KEY not set');" } }
  ]);
  lines.push(m.line); pid = m.id;

  tr = toolResult(tcId, 'Edit', '✅ Applied edit to weather-app/src/weatherClient.js', ts(base, 3.7), pid);
  lines.push(tr.line); pid = tr.id;

  // Add cache set after fetch
  tcId = `toolu_${shortId()}${shortId()}`;
  m = assistantMsg(null, model, ts(base, 4), pid, null, [
    { id: tcId, name: 'Edit', arguments: { file_path: 'weather-app/src/weatherClient.js', old_string: "  return {\n    city: data.name, country: data.sys.country,", new_string: "  const result = {\n    city: data.name, country: data.sys.country," } },
  ]);
  lines.push(m.line); pid = m.id;

  tr = toolResult(tcId, 'Edit', '✅ Applied edit to weather-app/src/weatherClient.js', ts(base, 4.1), pid);
  lines.push(tr.line); pid = tr.id;

  // Test
  tcId = `toolu_${shortId()}${shortId()}`;
  m = assistantMsg("Let me verify the fix works.", model, ts(base, 4.5), pid, null, [
    { id: tcId, name: 'exec', arguments: { command: 'cd weather-app && node -e "require(\'dotenv\').config(); const {getCurrentWeather}=require(\'./src/weatherClient\'); (async()=>{const a=await getCurrentWeather(\'Chicago\');console.log(\'First:\',a.fromCache);const b=await getCurrentWeather(\'Chicago\');console.log(\'Cached:\',b.fromCache)})()"' } }
  ]);
  lines.push(m.line); pid = m.id;

  tr = toolResult(tcId, 'exec', JSON.stringify({ status: 'completed', exitCode: 0, aggregated: 'First: undefined\nCached: true' }), ts(base, 5), pid);
  lines.push(tr.line); pid = tr.id;

  m = assistantMsg("Fixed. Here's what I did:\n\n1. **Added in-memory caching** with a 10-minute TTL — repeated searches for the same city return instantly from cache instead of hitting the degraded API\n2. **Cache eviction** at 500 entries to prevent memory leaks\n3. Responses include a `fromCache` flag so you can show staleness in the UI if you want\n\nThe root cause is OpenWeatherMap's free tier degradation (confirmed on their status page). The cache will absorb most of the impact — popular cities will be served from cache, and only the first request for each city will potentially be slow.\n\nFor a longer-term fix, you might want to consider:\n- Redis caching if you scale to multiple instances\n- A fallback weather API (WeatherAPI.com has a free tier)\n- Circuit breaker pattern to fail fast when the API is consistently down", model, ts(base, 5.5), pid);
  lines.push(m.line);

  writeSession(`${sid}.jsonl`, lines);
  console.log(`Session 4: ${sid} — Debug API timeout (${lines.length} events)`);
})();

// ============================================================
// Session 5: Deploy to production
// ============================================================
(() => {
  const sid = uid();
  const base = daysAgo(1, 11, 0);
  const model = 'claude-sonnet-4-20250514';
  const lines = [];
  let pid;

  lines.push(sessionLine(sid, ts(base, 0)));
  pid = shortId(); lines.push(modelChangeLine(model, ts(base, 0), pid));

  let m = userMsg("Let's deploy this. I have a VPS with Docker. Can you set up a Dockerfile and docker-compose?", ts(base, 1), pid);
  lines.push(m.line); pid = m.id;

  // Write Dockerfile
  let tcId = `toolu_${shortId()}${shortId()}`;
  m = assistantMsg("I'll create a production-ready Docker setup.", model, ts(base, 1.5), pid, null, [
    { id: tcId, name: 'Write', arguments: { file_path: 'weather-app/Dockerfile', content: `FROM node:20-alpine AS builder\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci --only=production\n\nFROM node:20-alpine\nWORKDIR /app\nCOPY --from=builder /app/node_modules ./node_modules\nCOPY . .\nEXPOSE 3000\nUSER node\nCMD ["node", "server.js"]` } }
  ]);
  lines.push(m.line); pid = m.id;

  let tr = toolResult(tcId, 'Write', '✅ Successfully wrote to weather-app/Dockerfile (12 lines)', ts(base, 1.8), pid);
  lines.push(tr.line); pid = tr.id;

  // Write docker-compose
  tcId = `toolu_${shortId()}${shortId()}`;
  m = assistantMsg(null, model, ts(base, 2), pid, null, [
    { id: tcId, name: 'Write', arguments: { file_path: 'weather-app/docker-compose.yml', content: `version: '3.8'\nservices:\n  weather-app:\n    build: .\n    ports:\n      - "3000:3000"\n    env_file:\n      - .env\n    restart: unless-stopped\n    healthcheck:\n      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:3000/"]\n      interval: 30s\n      timeout: 10s\n      retries: 3` } }
  ]);
  lines.push(m.line); pid = m.id;

  tr = toolResult(tcId, 'Write', '✅ Successfully wrote to weather-app/docker-compose.yml (14 lines)', ts(base, 2.2), pid);
  lines.push(tr.line); pid = tr.id;

  // Write .dockerignore
  tcId = `toolu_${shortId()}${shortId()}`;
  m = assistantMsg(null, model, ts(base, 2.5), pid, null, [
    { id: tcId, name: 'Write', arguments: { file_path: 'weather-app/.dockerignore', content: 'node_modules\n.env\n.git\nREADME.md\n*.log' } }
  ]);
  lines.push(m.line); pid = m.id;

  tr = toolResult(tcId, 'Write', '✅ Successfully wrote to weather-app/.dockerignore (5 lines)', ts(base, 2.7), pid);
  lines.push(tr.line); pid = tr.id;

  // Build
  tcId = `toolu_${shortId()}${shortId()}`;
  m = assistantMsg("Building the Docker image.", model, ts(base, 3), pid, null, [
    { id: tcId, name: 'exec', arguments: { command: 'cd weather-app && docker build -t weather-app:latest .' } }
  ]);
  lines.push(m.line); pid = m.id;

  tr = toolResult(tcId, 'exec', JSON.stringify({ status: 'completed', exitCode: 0, aggregated: '[+] Building 12.3s (12/12) FINISHED\n => [builder 1/3] FROM docker.io/library/node:20-alpine@sha256:abc123\n => [builder 2/3] COPY package*.json ./\n => [builder 3/3] RUN npm ci --only=production\n => [stage-1 1/3] COPY --from=builder /app/node_modules ./node_modules\n => [stage-1 2/3] COPY . .\n => exporting to image\n => => naming to docker.io/library/weather-app:latest\n\nImage size: 147MB' }), ts(base, 3.5), pid);
  lines.push(tr.line); pid = tr.id;

  // Run
  tcId = `toolu_${shortId()}${shortId()}`;
  m = assistantMsg(null, model, ts(base, 3.8), pid, null, [
    { id: tcId, name: 'exec', arguments: { command: 'cd weather-app && docker compose up -d && sleep 3 && curl -s http://localhost:3000/api/weather/London | head -c 200' } }
  ]);
  lines.push(m.line); pid = m.id;

  tr = toolResult(tcId, 'exec', JSON.stringify({ status: 'completed', exitCode: 0, aggregated: '[+] Running 2/2\n ✔ Network weather-app_default  Created\n ✔ Container weather-app-weather-app-1  Started\n{"city":"London","country":"GB","temp":7.8,"feelsLike":4.9,"humidity":79,"description":"light rain","icon":"10d","windSpeed":4.8}' }), ts(base, 4.2), pid);
  lines.push(tr.line); pid = tr.id;

  m = assistantMsg("Deployed and verified! The Docker setup includes:\n\n- **Multi-stage build** — builder stage installs deps, final image is lean (147MB)\n- **Non-root user** (`USER node`) for security\n- **Health check** — Docker monitors the app every 30s\n- **Auto-restart** (`unless-stopped`)\n- **`.dockerignore`** — keeps node_modules and .env out of the build context\n\nThe container is running and responding to API requests. For production, you'll want to add:\n- Nginx reverse proxy with SSL (Let's Encrypt)\n- Log aggregation\n- Rate limiting", model, ts(base, 5), pid);
  lines.push(m.line);

  writeSession(`${sid}.jsonl`, lines);
  console.log(`Session 5: ${sid} — Deploy to production (${lines.length} events)`);
})();

// ============================================================
// Session 6: Add 5-day forecast (sub-agent session)
// ============================================================
(() => {
  const sid = `${uid()}-subagent-forecast`;
  const base = daysAgo(0, 9, 0);
  const model = 'claude-sonnet-4-20250514';
  const lines = [];
  let pid;

  lines.push(sessionLine(sid, ts(base, 0), 'forecast-agent', 'subagent'));
  pid = shortId(); lines.push(modelChangeLine(model, ts(base, 0), pid));

  let m = userMsg("Add a 5-day forecast endpoint and update the frontend to show it. The main API client already handles auth.", ts(base, 1), pid);
  lines.push(m.line); pid = m.id;

  // Edit weather client to add forecast
  let tcId = `toolu_${shortId()}${shortId()}`;
  m = assistantMsg("I'll add the forecast function to the existing client and create a new route.", model, ts(base, 1.5), pid, null, [
    { id: tcId, name: 'Edit', arguments: { file_path: 'weather-app/src/weatherClient.js', old_string: "module.exports = { getCurrentWeather };", new_string: `async function getForecast(city) {\n  const cacheKey = \`forecast_\${city.toLowerCase().trim()}\`;\n  const cached = getCached(cacheKey);\n  if (cached) return { ...cached, fromCache: true };\n\n  const apiKey = process.env.OPENWEATHER_API_KEY;\n  const response = await client.get(\`\${BASE_URL}/forecast\`, {\n    params: { q: city, appid: apiKey, units: 'metric', cnt: 40 }\n  });\n\n  // Group by day\n  const daily = {};\n  for (const item of response.data.list) {\n    const date = item.dt_txt.split(' ')[0];\n    if (!daily[date]) daily[date] = [];\n    daily[date].push(item);\n  }\n\n  const result = Object.entries(daily).slice(0, 5).map(([date, items]) => ({\n    date,\n    high: Math.max(...items.map(i => i.main.temp_max)),\n    low: Math.min(...items.map(i => i.main.temp_min)),\n    description: items[Math.floor(items.length / 2)].weather[0].description,\n    icon: items[Math.floor(items.length / 2)].weather[0].icon\n  }));\n\n  setCache(cacheKey, result);\n  return result;\n}\n\nmodule.exports = { getCurrentWeather, getForecast };` } }
  ]);
  lines.push(m.line); pid = m.id;

  let tr = toolResult(tcId, 'Edit', '✅ Applied edit to weather-app/src/weatherClient.js', ts(base, 1.8), pid);
  lines.push(tr.line); pid = tr.id;

  // Add forecast route
  tcId = `toolu_${shortId()}${shortId()}`;
  m = assistantMsg(null, model, ts(base, 2), pid, null, [
    { id: tcId, name: 'Edit', arguments: { file_path: 'weather-app/routes/weather.js', old_string: "const { getCurrentWeather } = require('../src/weatherClient');", new_string: "const { getCurrentWeather, getForecast } = require('../src/weatherClient');" } }
  ]);
  lines.push(m.line); pid = m.id;

  tr = toolResult(tcId, 'Edit', '✅ Applied edit to weather-app/routes/weather.js', ts(base, 2.1), pid);
  lines.push(tr.line); pid = tr.id;

  tcId = `toolu_${shortId()}${shortId()}`;
  m = assistantMsg(null, model, ts(base, 2.3), pid, null, [
    { id: tcId, name: 'Edit', arguments: { file_path: 'weather-app/routes/weather.js', old_string: "module.exports = router;", new_string: "router.get('/:city/forecast', async (req, res) => {\n  try {\n    const forecast = await getForecast(req.params.city);\n    res.json(forecast);\n  } catch (err) {\n    if (err.response && err.response.status === 404) {\n      return res.status(404).json({ error: 'City not found' });\n    }\n    res.status(500).json({ error: 'Failed to fetch forecast' });\n  }\n});\n\nmodule.exports = router;" } }
  ]);
  lines.push(m.line); pid = m.id;

  tr = toolResult(tcId, 'Edit', '✅ Applied edit to weather-app/routes/weather.js', ts(base, 2.5), pid);
  lines.push(tr.line); pid = tr.id;

  // Test
  tcId = `toolu_${shortId()}${shortId()}`;
  m = assistantMsg("Testing the forecast endpoint.", model, ts(base, 2.8), pid, null, [
    { id: tcId, name: 'exec', arguments: { command: 'cd weather-app && node -e "require(\'dotenv\').config(); const {getForecast}=require(\'./src/weatherClient\'); getForecast(\'Tokyo\').then(d=>console.log(JSON.stringify(d,null,2))).catch(e=>console.error(e.message))"' } }
  ]);
  lines.push(m.line); pid = m.id;

  tr = toolResult(tcId, 'exec', JSON.stringify({ status: 'completed', exitCode: 0, aggregated: '[\n  { "date": "2026-02-14", "high": 12.4, "low": 5.1, "description": "clear sky", "icon": "01d" },\n  { "date": "2026-02-15", "high": 10.8, "low": 4.3, "description": "few clouds", "icon": "02d" },\n  { "date": "2026-02-16", "high": 8.2, "low": 2.9, "description": "light rain", "icon": "10d" },\n  { "date": "2026-02-17", "high": 11.1, "low": 5.6, "description": "scattered clouds", "icon": "03d" },\n  { "date": "2026-02-18", "high": 13.0, "low": 6.2, "description": "clear sky", "icon": "01d" }\n]' }), ts(base, 3.2), pid);
  lines.push(tr.line); pid = tr.id;

  m = assistantMsg("5-day forecast feature is complete:\n\n- **New endpoint:** `GET /api/weather/:city/forecast` — returns 5 days with high/low temps, description, and icon\n- **Aggregation logic:** Groups the 3-hour forecast data by day, picks midday conditions for description\n- **Caching:** Same 10-min cache pattern as current weather\n\nThe forecast data is ready to be consumed by the frontend. The main agent can update the UI to render it.", model, ts(base, 3.5), pid);
  lines.push(m.line);

  writeSession(`${sid}.jsonl`, lines);
  console.log(`Session 6: ${sid} — Add 5-day forecast / sub-agent (${lines.length} events)`);
})();

// ============================================================
// Session 7: Add unit tests (today)
// ============================================================
(() => {
  const sid = uid();
  const base = daysAgo(0, 14, 0);
  const model = 'claude-sonnet-4-20250514';
  const lines = [];
  let pid;

  lines.push(sessionLine(sid, ts(base, 0)));
  pid = shortId(); lines.push(modelChangeLine(model, ts(base, 0), pid));

  let m = userMsg("We need tests before shipping. Add unit tests for the weather client and API routes.", ts(base, 1), pid);
  lines.push(m.line); pid = m.id;

  let tcId = `toolu_${shortId()}${shortId()}`;
  m = assistantMsg("I'll set up Jest and write tests for the weather client and routes.", model, ts(base, 2), pid, null, [
    { id: tcId, name: 'exec', arguments: { command: 'cd weather-app && npm install --save-dev jest supertest' } }
  ]);
  lines.push(m.line); pid = m.id;

  let tr = toolResult(tcId, 'exec', JSON.stringify({ status: 'completed', exitCode: 0, aggregated: 'added 312 packages in 8.4s' }), ts(base, 2.5), pid);
  lines.push(tr.line); pid = tr.id;

  tcId = `toolu_${shortId()}${shortId()}`;
  m = assistantMsg(null, model, ts(base, 3), pid, null, [
    { id: tcId, name: 'Write', arguments: { file_path: 'weather-app/tests/weatherClient.test.js', content: "const { getCurrentWeather, getForecast } = require('../src/weatherClient');\nconst axios = require('axios');\n\njest.mock('axios', () => ({ create: () => ({ get: jest.fn() }) }));\n\ndescribe('weatherClient', () => {\n  describe('getCurrentWeather', () => {\n    it('returns formatted weather data', async () => {\n      const mockResponse = { data: { main: { temp: 22.5, humidity: 65 }, weather: [{ description: 'clear sky', icon: '01d' }], name: 'London' } };\n      require('axios').create().get.mockResolvedValue(mockResponse);\n      const result = await getCurrentWeather('London');\n      expect(result.name).toBe('London');\n      expect(result.temp).toBe(22.5);\n    });\n\n    it('throws on city not found', async () => {\n      require('axios').create().get.mockRejectedValue({ response: { status: 404 } });\n      await expect(getCurrentWeather('FakeCity123')).rejects.toThrow();\n    });\n  });\n\n  describe('getForecast', () => {\n    it('returns 5 days of forecast data', async () => {\n      const items = [];\n      for (let i = 0; i < 5; i++) {\n        const date = new Date(); date.setDate(date.getDate() + i);\n        items.push({ dt_txt: `${date.toISOString().split('T')[0]} 12:00:00`, main: { temp_max: 20+i, temp_min: 10+i }, weather: [{ description: 'clear', icon: '01d' }] });\n      }\n      require('axios').create().get.mockResolvedValue({ data: { list: items } });\n      const result = await getForecast('Tokyo');\n      expect(result.length).toBe(5);\n    });\n  });\n});" } }
  ]);
  lines.push(m.line); pid = m.id;

  tr = toolResult(tcId, 'Write', '✅ Wrote weather-app/tests/weatherClient.test.js (42 lines)', ts(base, 3.5), pid);
  lines.push(tr.line); pid = tr.id;

  tcId = `toolu_${shortId()}${shortId()}`;
  m = assistantMsg(null, model, ts(base, 4), pid, null, [
    { id: tcId, name: 'Write', arguments: { file_path: 'weather-app/tests/routes.test.js', content: "const request = require('supertest');\nconst express = require('express');\nconst weatherRoutes = require('../routes/weather');\n\nconst app = express();\napp.use('/api/weather', weatherRoutes);\n\ndescribe('Weather Routes', () => {\n  it('GET /api/weather/:city returns weather data', async () => {\n    const res = await request(app).get('/api/weather/London');\n    expect(res.status).toBe(200);\n    expect(res.body).toHaveProperty('temp');\n  });\n\n  it('GET /api/weather/:city/forecast returns forecast', async () => {\n    const res = await request(app).get('/api/weather/London/forecast');\n    expect(res.status).toBe(200);\n    expect(Array.isArray(res.body)).toBe(true);\n  });\n\n  it('returns 404 for unknown city', async () => {\n    const res = await request(app).get('/api/weather/FakeCity123456');\n    expect(res.status).toBe(404);\n  });\n});" } }
  ]);
  lines.push(m.line); pid = m.id;

  tr = toolResult(tcId, 'Write', '✅ Wrote weather-app/tests/routes.test.js (26 lines)', ts(base, 4.3), pid);
  lines.push(tr.line); pid = tr.id;

  tcId = `toolu_${shortId()}${shortId()}`;
  m = assistantMsg("Running the test suite.", model, ts(base, 5), pid, null, [
    { id: tcId, name: 'exec', arguments: { command: 'cd weather-app && npx jest --verbose' } }
  ]);
  lines.push(m.line); pid = m.id;

  tr = toolResult(tcId, 'exec', JSON.stringify({ status: 'completed', exitCode: 0, aggregated: ' PASS  tests/weatherClient.test.js\n  weatherClient\n    getCurrentWeather\n      ✓ returns formatted weather data (3 ms)\n      ✓ throws on city not found (1 ms)\n    getForecast\n      ✓ returns 5 days of forecast data (2 ms)\n\n PASS  tests/routes.test.js\n  Weather Routes\n    ✓ GET /api/weather/:city returns weather data (45 ms)\n    ✓ GET /api/weather/:city/forecast returns forecast (12 ms)\n    ✓ returns 404 for unknown city (8 ms)\n\nTest Suites: 2 passed, 2 total\nTests:       6 passed, 6 total\nTime:        1.847 s' }), ts(base, 5.5), pid);
  lines.push(tr.line); pid = tr.id;

  tcId = `toolu_${shortId()}${shortId()}`;
  m = assistantMsg("All tests passing. Let me add the test script to package.json.", model, ts(base, 6), pid, null, [
    { id: tcId, name: 'Edit', arguments: { file_path: 'weather-app/package.json', old_string: '"start": "node server.js"', new_string: '"start": "node server.js",\n    "test": "jest --verbose",\n    "test:watch": "jest --watch"' } }
  ]);
  lines.push(m.line); pid = m.id;

  tr = toolResult(tcId, 'Edit', '✅ Applied edit to weather-app/package.json', ts(base, 6.2), pid);
  lines.push(tr.line); pid = tr.id;

  m = assistantMsg("Test suite is set up and passing:\n\n- **6 tests** across 2 test files\n- **weatherClient.test.js** — unit tests for `getCurrentWeather` and `getForecast` with mocked axios\n- **routes.test.js** — integration tests using supertest for all API endpoints\n- **`npm test`** runs the full suite, `npm run test:watch` for development\n\nAll green. Ready to ship.", model, ts(base, 7), pid);
  lines.push(m.line);

  writeSession(`${sid}.jsonl`, lines);
  console.log(`Session 7: ${sid} — Add unit tests (${lines.length} events)`);
})();

console.log(`\nDone! Demo files written to ${DEMO_DIR}`);
console.log(`Files: ${fs.readdirSync(DEMO_DIR).filter(f => f.endsWith('.jsonl')).length} sessions`);
