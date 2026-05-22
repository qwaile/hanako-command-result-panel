/**
 * command-result-panel/extensions/interceptor.js
 *
 * Pi SDK 扩展：自动拦截 Agent 的 bash 工具调用并上报到命令面板。
 *
 * 使用 tool_execution_start / tool_execution_end 事件，
 * 覆盖所有工具执行场景（LLM 驱动 + Agent 直接调用）。
 *
 * 与插件的关系：完全通过 HTTP API 通信，零耦合。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export default function (pi) {
  const running = new Map();

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
      if (!_token) _serverBase = "http://127.0.0.1:14500";
    }
    return { base: _serverBase, token: _token };
  }

  // ── 步骤 1：命令开始时记录上下文 ──

  pi.on("tool_execution_start", async (event) => {
    if (event.toolName !== "bash") return;

    running.set(event.toolCallId, {
      command: event.args.command || "",
      cwd: event.args.cwd || process.cwd(),
      startTime: Date.now(),
    });
  });

  // ── 步骤 2：命令结束时提取结果并上报 ──

  pi.on("tool_execution_end", async (event) => {
    if (event.toolName !== "bash") return;

    const ctx = running.get(event.toolCallId);
    if (!ctx) return;
    running.delete(event.toolCallId);

    // 提取 stdout
    let stdout = "";
    let exitCode = 0;

    if (event.result) {
      const r = event.result;
      if (typeof r === "string") {
        stdout = r;
      } else if (typeof r.content === "string") {
        stdout = r.content;
      } else if (Array.isArray(r.content)) {
        for (const part of r.content) {
          if (part?.type === "text") stdout += part.text || "";
          else if (typeof part === "string") stdout += part;
        }
      }
      if (r.details?.exitCode !== undefined) exitCode = r.details.exitCode;
    }

    if (event.isError) exitCode = 1;

    const duration = Date.now() - ctx.startTime;
    const { base, token } = ensureServer();
    if (!token) return;

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
      // 静默
    }
  });
}
