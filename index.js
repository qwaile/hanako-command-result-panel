/**
 * command-result-panel/index.js
 *
 * 命令执行结果可视化面板插件主生命周期。
 * 维护一个环形缓冲区存储命令执行记录，通过 SSE 实时推送到 Widget 页面。
 */

// ── 插件主类 ──

export default class CommandPanelPlugin {
  async onload() {
    const { bus, config, log } = this.ctx;

    // 第一时间设置初始 API，防止路由注册时检测不到导致 fallback
    this.ctx._cmdPanelApi = {
      getRecords: () => [],
      clearRecords: () => 0,
      clearFilteredRecords: () => 0,
      maxRecords: 0,
      autoCollapse: true,
      sseClients: new Set(),
    };

    try {
      // 获取配置
      const maxRecords = await config.get("maxRecords") || 50;
      const autoCollapse = await config.get("autoCollapse") !== false;

      // ── 环形缓冲区 ──
      const records = [];
      let idCounter = 0;

      // SSE 客户端集合
      const sseClients = new Set();

      /** 广播给所有 SSE 客户端 */
      function broadcast(event, data) {
        const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        for (const client of sseClients) {
          try {
            client.enqueue(new TextEncoder().encode(msg));
          } catch {
            sseClients.delete(client);
          }
        }
      }

      /** 写入环形缓冲区（先进先出） */
      function pushRecord(record) {
        records.push(record);
        if (records.length > maxRecords) {
          const removed = records.shift();
          return removed;
        }
        return null;
      }

      /** 从环形缓冲区删除匹配的记录 */
      function removeRecords(filters) {
        if (!filters || (Array.isArray(filters.ids) && filters.ids.length > 0)) {
          if (filters?.ids?.length > 0) {
            const idSet = new Set(filters.ids);
            const before = records.length;
            for (let i = records.length - 1; i >= 0; i--) {
              if (idSet.has(records[i].id)) records.splice(i, 1);
            }
            return before - records.length;
          }
          // 清空全部
          const count = records.length;
          records.length = 0;
          return count;
        }
        // 按状态过滤清空
        if (filters?.status?.length > 0) {
          const statusSet = new Set(filters.status);
          const before = records.length;
          for (let i = records.length - 1; i >= 0; i--) {
            if (statusSet.has(records[i].status)) records.splice(i, 1);
          }
          return before - records.length;
        }
        // 无有效过滤 → 清空全部
        const count = records.length;
        records.length = 0;
        return count;
      }

      // ── 方案 A（可选）：监听 EventBus ──
      if (bus && bus.on) {
        bus.on("command:exec", (payload) => {
          const record = {
            id: ++idCounter,
            command: payload.command || "",
            cwd: payload.cwd || process.cwd(),
            exitCode: null,
            stdout: "",
            stderr: "",
            status: "running",
            duration: null,
            timestamp: new Date().toISOString(),
            timeAgo: Date.now(),
          };
          pushRecord(record);
          broadcast("new", record);
        });

        bus.on("command:result", (payload) => {
          const record = records.find((r) => r.id === payload.id);
          if (!record) return;
          record.exitCode = payload.exitCode;
          record.stdout = payload.stdout || "";
          record.stderr = payload.stderr || "";
          record.duration = payload.duration;
          record.status = payload.exitCode === 0 ? "success" : "failure";
          broadcast("result", record);
        });
      }

      // ── 注册 EventBus handler 供其他插件查询 ──
      if (bus && bus.handle) {
        bus.handle("command-panel:records", async (payload) => {
          const limit = payload?.limit || 50;
          const since = payload?.since || 0;
          let result = records;
          if (since > 0) result = result.filter((r) => r.id > since);
          return result.slice(-limit);
        });

        bus.handle("command-panel:clear", async () => {
          const count = records.length;
          records.length = 0;
          return { cleared: count };
        });
      }

      // ── 作为 request 能力注册 ──
      if (bus && bus.registerCapability) {
        bus.registerCapability({
          type: "command-panel:records",
          title: "Command Records",
          description: "Read recent command execution records tracked by the command-result-panel plugin.",
          permission: "plugin.bus.request",
        });
        bus.registerCapability({
          type: "command-panel:clear",
          title: "Clear Command Records",
          description: "Clear all command execution records.",
          permission: "plugin.bus.request",
        });
      }

      // ── 鉴权：记录首次收到的 token，后续请求校验一致 ──
      let _authToken = null;

      function verifyAuth(token) {
        // 首次请求：锁定 token
        if (!_authToken) {
          if (token) _authToken = token;
          return true;
        }
        return token === _authToken;
      }

      // ── 提供 API 给 routes ──
      this.ctx._cmdPanelApi = {
        getRecords: (limit = 50, since = 0) => {
          let result = records;
          if (since > 0) result = result.filter((r) => r.id > since);
          return result.slice(-limit);
        },
        clearRecords: () => {
          const count = records.length;
          records.length = 0;
          return count;
        },
        clearFilteredRecords: (filters) => {
          return removeRecords(filters);
        },
        pushRecord,
        broadcast,
        sseClients,
        maxRecords,
        autoCollapse,
        getRecordCount: () => records.length,
        verifyAuth,
      };

      log.info(`Command Panel loaded, maxRecords=${maxRecords}, autoCollapse=${autoCollapse}`);
    } catch (err) {
      log.error(`Command Panel onload failed: ${err.message}`);
      // 确保 routes 至少有 fallback 可用
      this.ctx._cmdPanelApi = this.ctx._cmdPanelApi || {
        getRecords: () => [],
        clearRecords: () => 0,
        clearFilteredRecords: () => 0,
        maxRecords: 50,
        autoCollapse: true,
        sseClients: new Set(),
      };
    }
  }

  async onunload() {
    const api = this.ctx?._cmdPanelApi;
    if (api && api.sseClients) {
      for (const client of api.sseClients) {
        try { client.close(); } catch {}
      }
      api.sseClients.clear();
    }
    this.ctx?.log?.info("Command Panel unloaded");
  }
}
