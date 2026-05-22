/**
 * command-result-panel/extensions/interceptor.js
 *
 * Pi SDK 扩展：自动拦截 Agent 的 bash 工具调用并上报到命令面板。
 *
 * 方案 B 的核心实现：
 *   1. tool_call  事件 → 记录命令开始（command、cwd、startTime）
 *   2. tool_result 事件 → 提取 stdout、exitCode、耗时，POST 到插件 API
 *
 * 与插件的关系：完全通过 HTTP API 通信，零耦合。
 * 让 Agent 对插件的存在无感知，但每一条 bash 调用自动出现在命令面板中。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export default function (pi) {
  // 正在执行的 bash 命令（toolCallId → 上下文）
  const running = new Map();

  // 读取 server-info.json 拿到 token 和端口，缓存 60s
  let _serverBase = null;
  let _token = null;
  let _lastRead = 0;

  function ensureServer() {
    const now = Date.now();
    if (_token && now - _lastRead < 60000) return { base: _serverBase, token: _token };
    try {
      const hanaHome = process.env.HANA_HOME || join(homedir(), ".hanako");
      const raw = readFileSync(join(hanaHome, "server-info.json"), "utf-8");
      const info = JSON.parse(raw);
      _serverBase = `http://127.0.0.1:${info.port || 14500}`;
      _token = info.token || "";
      _lastRead = now;
    } catch {
      // 读不到说明 server 还没就绪，不报错
      if (!_token) _serverBase = "http://127.0.0.1:14500";
    }
    return { base: _serverBase, token: _token };
  }

  // ── 步骤 1：命令开始时记录上下文 ──

  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return;

    running.set(event.toolCallId, {
      command: event.input.command || "",
      cwd: event.input.cwd || process.cwd(),
      startTime: Date.now(),
    });
  });

  // ── 步骤 2：命令结束时提取结果并上报 ──

  pi.on("tool_result", async (event) => {
    if (event.toolName !== "bash") return;

    const ctx = running.get(event.toolCallId);
    if (!ctx) return;
    running.delete(event.toolCallId);

    // 提取 stdout
    let stdout = "";
    if (typeof event.content === "string") {
      stdout = event.content;
    } else if (Array.isArray(event.content)) {
      for (const part of event.content) {
        if (part && typeof part === "object") {
          if (part.type === "text") stdout += part.text || "";
        } else if (typeof part === "string") {
          stdout += part;
        }
      }
    }

    // 提取 exitCode: 优先从 details 取，其次 isError 标记
    let exitCode = 0;
    if (event.details && event.details.exitCode !== undefined) {
      exitCode = event.details.exitCode;
    } else if (event.isError) {
      exitCode = 1;
    }

    const duration = Date.now() - ctx.startTime;
    const { base, token } = ensureServer();
    if (!token) return; // token 不可用，暂时跳过

    try {
      await fetch(`${base}/api/plugins/command-result-panel/record`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          command: ctx.command,
          cwd: ctx.cwd,
          exitCode,
          stdout: (stdout || "").slice(0, 50000),
          stderr: "",
          duration,
        }),
      });
    } catch {
      // 静默失败，不影响 Agent 流程
    }
  });
}
