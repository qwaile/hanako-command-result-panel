/**
 * command-result-panel/routes/panel.js
 *
 * 提供 Widget 页面渲染、REST API 和 SSE 实时推送端点。
 */

// ── 鉴权辅助函数 ──

function extractToken(c) {
  const authHeader = c.req.header("Authorization") || "";
  if (authHeader.startsWith("Bearer ")) return authHeader.slice(7);
  return c.req.query("token") || "";
}

function verifyOrSetAuth(ctx, c) {
  const token = extractToken(c);
  const api = ctx._cmdPanelApi;
  if (!api || !api.verifyAuth) return true;
  return api.verifyAuth(token);
}

// ── 工具函数 ──

function escapeHtml(text) {
  const map = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return String(text).replace(/[&<>"']/g, (ch) => map[ch]);
}

function formatTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

function statusText(status) {
  const map = {
    running: "执行中",
    success: "成功",
    failure: "失败",
  };
  return map[status] || status;
}

function statusDotClass(status) {
  const map = {
    running: "dot-running",
    success: "dot-success",
    failure: "dot-failure",
  };
  return map[status] || "dot-running";
}

// ── 客户端 JavaScript（独立字符串，避免模板嵌套冲突）──

const CLIENT_JS = `
const BASE = 'API_BASE_PLACEHOLDER';
const HANA_TOKEN = window.__HANA_TOKEN__ || '';
const IS_WIDGET = WIDGET_PLACEHOLDER;

var records = INITIAL_DATA;
var expandedMap = {};
var lastRecordId = 0;
var _pollTimer = null;
var MAX_RECORDS = MAX_RECORDS_PLACEHOLDER;

// 预计算 lastRecordId
for (var i = 0; i < records.length; i++) {
  if (records[i].id > lastRecordId) lastRecordId = records[i].id;
}

/** 保持前端记录数不超过上限 */
function trimRecords() {
  while (records.length > MAX_RECORDS) records.pop();
}

function authFetch(url, options) {
  options = options || {};
  options.headers = options.headers || {};
  if (HANA_TOKEN) {
    options.headers['Authorization'] = 'Bearer ' + HANA_TOKEN;
  }
  options.credentials = 'include';
  return fetch(url, options);
}

function truncate(text, max) {
  if (!text) return '';
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}

function render() {
  var html = '<div class="widget">' +
    '<div class="header">' +
      '<span class="header-title">🖥 命令历史</span>' +
      '<span class="record-count">(' + records.length + ')</span>' +
      '<div class="header-actions">' +
        '<button class="header-btn" onclick="expandAll()">全部展开</button>' +
        '<button class="header-btn" onclick="collapseAll()">全部折叠</button>' +
        '<button class="header-btn" onclick="clearAll()">清空</button>' +
      '</div>' +
    '</div>' +
    '<div class="scroll-area" id="scrollArea">' +
      (records.length === 0 ? renderEmpty() : records.map(renderCard).join('')) +
    '</div>' +
  '</div>';
  document.getElementById('app').innerHTML = html;
  var sa = document.getElementById('scrollArea');
  if (sa) sa.scrollTop = 0;
}

function renderEmpty() {
  return '<div class="empty-state">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="empty-icon">' +
      '<polyline points="4 17 10 11 4 5"/>' +
      '<line x1="12" y1="19" x2="20" y2="19"/>' +
    '</svg>' +
    '<p class="empty-text">暂无命令记录</p>' +
    '<p class="empty-hint">Agent 执行命令后将自动出现在这里</p>' +
  '</div>';
}

function renderCard(record) {
  var isOpen = !!expandedMap[record.id];
  var sClass = statusDotClass(record.status);
  var sText = statusText(record.status);
  var durationText = record.duration != null ? (record.duration / 1000).toFixed(2) + 's' : '—';
  var timeText = formatTime(record.timestamp);
  var stdout = escapeHtml(record.stdout || '');
  var stderr = escapeHtml(record.stderr || '');
  var cmd = escapeHtml(record.command || '');

  return '<div class="card ' + (record.status === 'running' ? 'card-running' : '') + '">' +
    '<div class="card-header" onclick="toggleCard(' + record.id + ')">' +
      '<span class="status-dot ' + sClass + '"></span>' +
      '<span class="command-text" title="' + cmd + '">' + truncate(cmd, 60) + '</span>' +
      '<span class="meta">📅' + timeText + '</span>' +
      '<span class="meta">⏱' + durationText + '</span>' +
      '<svg class="chevron ' + (isOpen ? 'open' : '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>' +
    '</div>' +
    '<div class="card-body ' + (isOpen ? 'open' : '') + '">' +
      (stdout ? '<div class="output-block"><div class="output-label">stdout</div><div class="output-content">' + stdout + '</div></div>' : '') +
      (stderr ? '<div class="output-block stderr"><div class="output-label stderr">stderr</div><div class="output-content">' + stderr + '</div></div>' : '') +
      '<div class="detail-row">' +
        '<span>退出码: ' + (record.exitCode != null ? record.exitCode : '—') + '</span>' +
        '<span>状态: ' + sText + '</span>' +
        '<span>' + (record.cwd ? '目录: ' + truncate(escapeHtml(record.cwd), 30) : '') + '</span>' +
        '<button class="copy-btn" onclick="copyCommand(' + record.id + ', event)">📋复制命令</button>' +
      '</div>' +
      (record.command && record.command.length > 60 ? '<div class="full-command' + (expandedMap['full-' + record.id] ? ' expanded' : '') + '" onclick="toggleCardFullCmd(' + record.id + ')"><span class="cmd-preview">' + cmd + '</span></div>' : '') +
    '</div>' +
  '</div>';
}

// ── 交互函数 ──

function toggleCard(id) {
  if (expandedMap[id]) {
    delete expandedMap[id];
  } else {
    expandedMap[id] = true;
  }
  render();
}

function expandAll() {
  for (var i = 0; i < records.length; i++) {
    expandedMap[records[i].id] = true;
  }
  render();
}

function collapseAll() {
  expandedMap = {};
  render();
}

function copyCommand(id, event) {
  event.stopPropagation();
  var record = null;
  for (var i = 0; i < records.length; i++) {
    if (records[i].id === id) { record = records[i]; break; }
  }
  if (!record) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(record.command).then(function() {
      var btn = event.currentTarget;
      btn.textContent = '✅已复制';
      setTimeout(render, 1200);
    })["catch"](function() {
      fallbackCopy(record.command, event.currentTarget);
    });
  } else {
    fallbackCopy(record.command, event.currentTarget);
  }
}

function fallbackCopy(text, btn) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    btn.textContent = '✅已复制';
    setTimeout(render, 1200);
  } catch(e) {
    btn.textContent = '❌复制失败';
    setTimeout(render, 1200);
  }
  document.body.removeChild(ta);
}

function showConfirmModal(msg) {
  return new Promise(function(resolve) {
    var overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    var card = document.createElement('div');
    card.className = 'confirm-card';
    var text = document.createElement('div');
    text.className = 'confirm-text';
    text.textContent = msg;
    var actions = document.createElement('div');
    actions.className = 'confirm-actions';
    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'confirm-btn confirm-cancel';
    cancelBtn.textContent = '取消';
    cancelBtn.onclick = function() { close(); resolve(false); };
    var okBtn = document.createElement('button');
    okBtn.className = 'confirm-btn confirm-ok';
    okBtn.textContent = '确定';
    okBtn.onclick = function() { close(); resolve(true); };
    function close() {
      overlay.classList.remove('active');
      card.classList.remove('active');
      setTimeout(function() {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      }, 200);
    }
    actions.appendChild(cancelBtn);
    actions.appendChild(okBtn);
    card.appendChild(text);
    card.appendChild(actions);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    setTimeout(function() { overlay.classList.add('active'); card.classList.add('active'); }, 10);
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) { close(); resolve(false); }
    });
  });
}

function clearAll() {
  showConfirmModal('确定要清空所有命令记录吗？').then(function(ok) {
    if (!ok) return;
    authFetch(BASE + '/clear', { method: 'POST' }).then(function(r) {
      return r.json();
    }).then(function(data) {
      if (data.ok) {
        records = [];
        expandedMap = {};
        lastRecordId = 0;
        render();
      }
    })["catch"](function(err) {
      console.error('clear failed:', err);
    });
  });
}

function toggleCardFullCmd(id) {
  var key = 'full-' + id;
  if (expandedMap[key]) {
    delete expandedMap[key];
  } else {
    expandedMap[key] = true;
  }
  render();
}

// ── 工具函数 ──

function escapeHtml(text) {
  var d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

function statusDotClass(status) {
  if (status === 'running') return 'dot-running';
  if (status === 'success') return 'dot-success';
  if (status === 'failure') return 'dot-failure';
  return 'dot-running';
}

function statusText(status) {
  if (status === 'running') return '执行中';
  if (status === 'success') return '成功';
  if (status === 'failure') return '失败';
  return status;
}

function formatTime(iso) {
  try {
    var d = new Date(iso);
    var h = d.getHours().toString().padStart(2, '0');
    var m = d.getMinutes().toString().padStart(2, '0');
    var s = d.getSeconds().toString().padStart(2, '0');
    return h + ':' + m + ':' + s;
  } catch(e) {
    return iso;
  }
}

// ── SSE 连接 ──

function connectSSE() {
  var evtSource = null;
  try {
    evtSource = new EventSource(BASE + '/stream?token=' + encodeURIComponent(HANA_TOKEN));
  } catch(e) {
    // fallback: polling
    startPolling();
    return;
  }

  evtSource.addEventListener('connected', function() {
    console.log('SSE connected');
  });

  evtSource.addEventListener('new', function(e) {
    try {
      var record = JSON.parse(e.data);
      // 去重
      var exists = false;
      for (var i = 0; i < records.length; i++) {
        if (records[i].id === record.id) { exists = true; break; }
      }
      if (!exists) {
        records.unshift(record);
        trimRecords();
        expandedMap[record.id] = record.status === 'running';
        if (record.id > lastRecordId) lastRecordId = record.id;
        render();
      }
    } catch(err) {
      console.error('SSE new error:', err);
    }
  });

  evtSource.addEventListener('result', function(e) {
    try {
      var record = JSON.parse(e.data);
      for (var i = 0; i < records.length; i++) {
        if (records[i].id === record.id) {
          records[i] = record;
          if (AUTO_COLLAPSE) {
            expandedMap[record.id] = record.status !== 'success';
          }
          render();
          break;
        }
      }
    } catch(err) {
      console.error('SSE result error:', err);
    }
  });

  evtSource.addEventListener('clear', function() {
    records = [];
    expandedMap = {};
    lastRecordId = 0;
    render();
  });

  evtSource.onerror = function() {
    evtSource.close();
    startPolling();
  };
}

function startPolling() {
  if (_pollTimer) return;
  _pollTimer = setInterval(function() {
    authFetch(BASE + '/records?since=' + lastRecordId + '&limit=10').then(function(r) {
      return r.json();
    }).then(function(data) {
      if (data.records && data.records.length > 0) {
        for (var i = 0; i < data.records.length; i++) {
          var record = data.records[i];
          var exists = false;
          for (var j = 0; j < records.length; j++) {
            if (records[j].id === record.id) { exists = true; break; }
          }
          if (!exists) {
            records.unshift(record);
            trimRecords();
            if (AUTO_COLLAPSE && record.status === 'success') {
              expandedMap[record.id] = false;
            } else if (record.status === 'running') {
              expandedMap[record.id] = true;
            }
            if (record.id > lastRecordId) lastRecordId = record.id;
          } else {
            // 更新已有记录
            for (var j = 0; j < records.length; j++) {
              if (records[j].id === record.id) {
                records[j] = record;
                break;
              }
            }
          }
        }
        render();
      }
    })["catch"](function() {});
  }, 3000);
}

// ── 初始化 ──
render();
connectSSE();

// 通知父窗口（Hanako 桌面端 iframe）页面已就绪
if (window.parent) {
  window.parent.postMessage({ type: 'ready' }, '*');
}
`;

// ── SSR 页面渲染 ──

function renderWidgetPage(ctx, c, surface) {
  const api = ctx._cmdPanelApi;
  const isWidget = surface === "widget";
  const records = api ? api.getRecords(50, 0) : [];
  const autoCollapse = api ? api.autoCollapse : true;
  const initialData = JSON.stringify(records);
  const token = extractToken(c);

  // 主题检测：从 query 或 cookie 读取，默认 light
  const theme = c.req.query("theme") || "light";
  const tokenJson = JSON.stringify(token);
  const basePath = `/api/plugins/${ctx.pluginId || "command-result-panel"}`;

  // 替换客户端 JS 中的占位符
  let clientJs = CLIENT_JS
    .replace("API_BASE_PLACEHOLDER", basePath)
    .replace("WIDGET_PLACEHOLDER", isWidget ? "true" : "false")
    .replace("INITIAL_DATA", initialData)
    .replace("AUTO_COLLAPSE", autoCollapse ? "true" : "false")
    .replace("MAX_RECORDS_PLACEHOLDER", String(api ? api.maxRecords : 50));

  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>命令面板</title>
<style>
  :root {
    --bg: ${isWidget ? "transparent" : "#ffffff"};
    --bg-card: #ffffff;
    --bg-hover: #f3f4f6;
    --bg-muted: #f9fafb;
    --bg-code: #f8f9fa;
    --border: #e5e7eb;
    --text: #111827;
    --text-secondary: #6b7280;
    --text-muted: #9ca3af;
    --success: #22c55e;
    --failure: #ef4444;
    --running: #f59e0b;
    --radius: 6px;
    --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    --mono-font: "JetBrains Mono", "Fira Code", "Consolas", monospace;
  }

  @media (prefers-color-scheme: dark) {
    :root {
      --bg: ${isWidget ? "transparent" : "#1a1a2e"};
      --bg-card: #16213e;
      --bg-hover: #1a2744;
      --bg-muted: #1a1a2e;
      --bg-code: #0f1629;
      --border: #2a3a5c;
      --text: #e2e8f0;
      --text-secondary: #94a3b8;
      --text-muted: #64748b;
    }
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: var(--font);
    font-size: 13px;
    color: var(--text);
    background: var(--bg);
    height: 100vh;
    overflow: hidden;
  }

  #app { height: 100%; }

  .widget { height: 100%; display: flex; flex-direction: column; }

  .header {
    flex-shrink: 0;
    padding: 8px 12px;
    display: flex;
    align-items: center;
    gap: 8px;
    border-bottom: 1px solid var(--border);
  }
  .header-title { font-size: 13px; font-weight: 600; flex: 1; }
  .record-count { font-size: 11px; color: var(--text-muted); white-space: nowrap; }
  .header-actions { display: flex; gap: 4px; flex-shrink: 0; }
  .header-btn {
    background: none; border: 1px solid var(--border); border-radius: 4px;
    cursor: pointer; font-size: 11px; color: var(--text-secondary);
    padding: 2px 6px; white-space: nowrap;
    transition: all 0.15s;
  }
  .header-btn:hover {
    color: var(--text); border-color: var(--text-secondary);
  }

  .scroll-area {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    scroll-behavior: smooth;
    padding: ${isWidget ? "6px" : "12px"};
  }

  .scroll-area::-webkit-scrollbar { width: 5px; }
  .scroll-area::-webkit-scrollbar-track { background: transparent; }
  .scroll-area::-webkit-scrollbar-thumb {
    background: var(--border); border-radius: 3px;
    transition: background 0.2s;
  }
  .scroll-area::-webkit-scrollbar-thumb:hover { background: var(--text-muted); }

  /* 空状态 */
  .empty-state {
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    height: 100%; gap: 8px;
    color: var(--text-muted);
  }
  .empty-icon { width: 48px; height: 48px; opacity: 0.4; }
  .empty-text { font-size: 13px; }
  .empty-hint { font-size: 11px; }

  /* 命令卡片 */
  .card {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    margin-bottom: 6px;
    overflow: hidden;
    background: var(--bg-card);
    transition: border-color 0.15s;
  }
  .card:hover { border-color: var(--text-muted); }
  .card.card-running {
    border-color: var(--running);
    box-shadow: 0 0 0 1px var(--running);
  }

  .card-header {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 10px; cursor: pointer; user-select: none;
    transition: background 0.15s;
  }
  .card-header:hover { background: var(--bg-hover); }

  .status-dot {
    width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
  }
  .dot-success { background: var(--success); }
  .dot-failure { background: var(--failure); }
  .dot-running {
    background: var(--running);
    animation: pulse 1.5s infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  .command-text {
    flex: 1; font-family: var(--mono-font);
    font-size: 12px; white-space: nowrap; overflow: hidden;
    text-overflow: ellipsis; min-width: 0;
  }
  .meta {
    font-size: 10px; color: var(--text-muted);
    white-space: nowrap; flex-shrink: 0;
  }

  .chevron {
    width: 14px; height: 14px; flex-shrink: 0;
    transition: transform 0.2s; color: var(--text-muted);
  }
  .chevron.open { transform: rotate(90deg); }

  .card-body {
    padding: 0 10px 8px; display: none;
  }
  .card-body.open { display: block; }

  .output-block {
    margin-top: 6px; border-radius: 4px; overflow: hidden;
    border: 1px solid var(--border);
  }
  .output-block.stderr {
    border-color: var(--failure);
    border-width: 1px;
  }

  .output-label {
    font-size: 10px; font-weight: 600; padding: 2px 8px;
    background: var(--bg-muted);
    border-bottom: 1px solid var(--border);
    color: var(--text-secondary);
  }
  .output-label.stderr {
    background: #fef2f2; color: var(--failure);
  }
  @media (prefers-color-scheme: dark) {
    .output-label.stderr { background: rgba(239,68,68,0.1); }
  }

  .output-content {
    font-family: var(--mono-font); font-size: 11px;
    padding: 6px 8px; white-space: pre-wrap; word-break: break-all;
    max-height: 200px; overflow-y: auto;
    background: var(--bg-code);
    line-height: 1.5;
  }

  .detail-row {
    display: flex; gap: 12px; font-size: 10px;
    color: var(--text-muted); margin-top: 6px;
    flex-wrap: wrap; align-items: center;
  }

  .copy-btn {
    background: none; border: none; cursor: pointer;
    font-size: 11px; color: var(--text-secondary);
    padding: 0 2px; margin-left: auto;
    transition: color 0.15s;
  }
  .copy-btn:hover { color: var(--text); }

  .full-command {
    margin-top: 4px;
    cursor: pointer;
  }
  .full-command .cmd-preview {
    font-family: var(--mono-font); font-size: 11px;
    color: var(--text-muted);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    word-break: break-all;
    line-height: 1.4;
  }
  .full-command.expanded .cmd-preview {
    display: block;
    -webkit-line-clamp: unset;
  }
  .full-command::after {
    content: "展开完整命令 ▾";
    font-size: 10px; color: var(--text-muted);
    display: block; margin-top: 2px;
  }
  .full-command.expanded::after {
    content: "收起 ▴";
  }

  /* Toast */
  .toast {
    position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
    background: var(--text); color: var(--bg);
    padding: 6px 16px; border-radius: 20px; font-size: 12px;
    opacity: 0; transition: opacity 0.3s; pointer-events: none;
    z-index: 100;
  }
  .toast.show { opacity: 1; }

  /* 确认弹窗 */
  .confirm-overlay {
    position: fixed; inset: 0; z-index: 200;
    background: rgba(0,0,0,0);
    transition: background 0.2s;
    display: flex; align-items: center; justify-content: center;
  }
  .confirm-overlay.active { background: rgba(0,0,0,0.4); }
  .confirm-card {
    background: var(--bg-card); border: 1px solid var(--border);
    border-radius: 10px; padding: 20px; max-width: 300px; width: 90%;
    box-shadow: 0 8px 32px rgba(0,0,0,0.2);
    transform: scale(0.9); opacity: 0;
    transition: transform 0.2s, opacity 0.2s;
  }
  .confirm-card.active { transform: scale(1); opacity: 1; }
  .confirm-text { font-size: 14px; margin-bottom: 16px; text-align: center; }
  .confirm-actions { display: flex; gap: 12px; justify-content: center; }
  .confirm-btn {
    padding: 7px 24px; border: 1px solid var(--border);
    border-radius: 6px; font-size: 13px; cursor: pointer;
    transition: all 0.15s; min-width: 80px;
    background: var(--bg-card); color: var(--text-secondary);
  }
  .confirm-btn:hover { border-color: var(--text-secondary); color: var(--text); }
  .confirm-ok { background: #ef4444; color: #fff; border-color: #ef4444; }
  .confirm-ok:hover { background: #dc2626; border-color: #dc2626; }
</style>
</head>
<body data-hana-theme="${theme.replace(/"/g, '&quot;')}" data-surface="${surface}">
<div id="app"></div>
<div class="toast" id="toast"></div>
<script>window.__HANA_TOKEN__ = ${tokenJson};</script>
<script>${clientJs}</script>
</body>
</html>`;
}

/** 简易加载中 HTML：每隔 3 秒尝试重新加载页面，直到 API 就绪 */
function renderLoading(c, surface) {
  const isWidget = surface === "widget";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:-apple-system,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;color:#999;font-size:${isWidget?"12px":"14px"};background:transparent;gap:8px}@keyframes dots{0%,20%{content:''}40%{content:'.'}60%{content:'..'}80%,100%{content:'...'}}#dots::after{content:'';animation:dots 2s infinite}</style></head><body><p>⏳ 命令面板正在初始化<span id="dots"></span></p><script>window.parent?.postMessage({type:'ready'},'*');setTimeout(function(){location.reload()},3000);<\/script></body></html>`;
}

/** 获取 API（可能还未就绪） */
function getApi(ctx) {
  const api = ctx._cmdPanelApi;
  if (!api || typeof api.getRecords !== "function") return null;
  return api;
}

// ── Route 注册 ──

export default function registerCommandPanelRoutes(app, ctx) {
  let sseConnections = 0;
  const MAX_SSE_CONNECTIONS = 10;

  // ── Widget 页面 ──
  app.get("/widget", (c) => {
    const api = getApi(ctx);
    if (!api) return c.html(renderLoading(c, "widget"));
    return c.html(renderWidgetPage(ctx, c, "widget"));
  });

  // ── REST API: 查询记录列表 ──
  app.get("/records", (c) => {
    const api = getApi(ctx);
    if (!api) return c.json({ records: [] });
    if (!verifyOrSetAuth(ctx, c)) return c.json({ error: "unauthorized" }, 401);
    const limit = parseInt(c.req.query("limit")) || 50;
    const since = parseInt(c.req.query("since")) || 0;
    return c.json({ records: api.getRecords(limit, since) });
  });

  // ── REST API: Agent 上报命令结果 ──
  app.post("/record", async (c) => {
    const api = getApi(ctx);
    if (!api) return c.json({ error: "API not ready" }, 503);
    if (!verifyOrSetAuth(ctx, c)) return c.json({ error: "unauthorized" }, 401);

    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }

    if (!body || !body.command) {
      return c.json({ error: "missing required field: command" }, 400);
    }

    // 更新已有记录（来自 EventBus）
    if (body.id) {
      const records = api.getRecords(9999, 0);
      const record = records.find((r) => r.id === body.id);
      if (record) {
        record.exitCode = body.exitCode ?? null;
        record.stdout = (body.stdout || "").slice(0, 50000);
        record.stderr = (body.stderr || "").slice(0, 50000);
        record.duration = body.duration;
        record.status =
          body.exitCode === 0
            ? "success"
            : body.exitCode === null
              ? "running"
              : "failure";
        api.broadcast("result", record);
        return c.json({ ok: true, id: record.id });
      }
      return c.json({ ok: false, error: "record not found" }, 404);
    }

    // 新建记录（Agent 主动上报）
    const { command, cwd, exitCode, stdout, stderr, duration } = body;
    const safeExitCode = exitCode ?? null;
    const id = Date.now() + Math.floor(Math.random() * 1000);
    const record = {
      id,
      command,
      cwd: cwd || process.cwd(),
      exitCode: safeExitCode,
      stdout: (stdout || "").slice(0, 50000),
      stderr: (stderr || "").slice(0, 50000),
      status:
        safeExitCode === 0
          ? "success"
          : safeExitCode === null
            ? "running"
            : "failure",
      duration: duration ?? null,
      timestamp: new Date().toISOString(),
      timeAgo: Date.now(),
    };
    api.pushRecord(record);
    api.broadcast(
      record.status === "running" ? "new" : "result",
      record
    );
    return c.json({ ok: true, id });
  });

  // ── REST API: 清空记录 ──
  app.post("/clear", async (c) => {
    const api = getApi(ctx);
    if (!api) return c.json({ ok: false, error: "API not ready" }, 503);
    if (!verifyOrSetAuth(ctx, c)) return c.json({ error: "unauthorized" }, 401);

    let filters = null;
    try {
      const body = await c.req.json();
      if (body && body.status) {
        filters = { status: Array.isArray(body.status) ? body.status : [body.status] };
      }
    } catch {
      /* body 为空 → 清空全部 */
    }

    const cleared = api.clearFilteredRecords
      ? api.clearFilteredRecords(filters)
      : api.clearRecords();
    api.broadcast("clear", { cleared });
    return c.json({ ok: true, cleared, filtered: !!filters });
  });

  // ── SSE: 实时推送 ──
  app.get("/stream", (c) => {
    const api = getApi(ctx);
    if (!api) return c.json({ error: "API not ready" }, 503);
    if (!verifyOrSetAuth(ctx, c)) return c.json({ error: "unauthorized" }, 401);

    if (sseConnections >= MAX_SSE_CONNECTIONS) {
      return c.json({ error: "too many SSE connections" }, 503);
    }
    sseConnections++;

    const te = new TextEncoder();
    const abortSignal = c.req.raw?.signal;

    const stream = new ReadableStream({
      start(controller) {
        let readyApi = getApi(ctx);

        if (!readyApi) {
          controller.enqueue(
            te.encode("data: " + JSON.stringify({ type: "loading" }) + "\n\n")
          );
          const waitTimer = setInterval(() => {
            readyApi = getApi(ctx);
            if (readyApi || abortSignal?.aborted) {
              clearInterval(waitTimer);
              if (readyApi && !abortSignal?.aborted) {
                readyApi.sseClients.add(controller);
                controller.enqueue(
                  te.encode("event: connected\ndata: {}\n\n")
                );
              } else {
                try { controller.close(); } catch {}
              }
            }
          }, 1000);
          return;
        }

        // API 已就绪：注册 controller，发送 connected
        readyApi.sseClients.add(controller);
        controller.enqueue(
          te.encode("event: connected\ndata: {}\n\n")
        );
      },
      cancel() {
        // 从 sseClients 移除（遍历查找当前 stream 对应的 controller 比较困难，
        // 但因为 cancel 时整个 ReadableStream 废弃，由 broadcast 的 try/catch 清理）
        sseConnections = Math.max(0, sseConnections - 1);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });

  ctx.log.info("Command Panel routes registered");
}
