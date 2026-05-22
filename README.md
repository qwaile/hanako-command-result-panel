# Command Result Panel

一个 Hanako Widget 插件，在侧栏中显示最近执行的命令及其输出，以**可折叠卡片**的形式组织，每条命令的执行结果一目了然。

## 效果

每条命令显示为一张卡片，包含：

- 状态圆点（绿色=成功、红色=失败、黄色闪烁=执行中）
- 命令文本（截短显示，超出鼠标悬停可见）
- 执行时间、耗时
- 展开后：stdout 区块、stderr 区块（红色边框）
- 退出码、状态文字、**复制命令**按钮
- 长命令可展开查看完整文本

## 数据结构

```
CommandRecord {
  id: number,          // 自增 ID
  command: string,     // 原始命令
  cwd: string,         // 工作目录
  exitCode: number|null, // 退出码
  stdout: string,      // 标准输出
  stderr: string,      // 错误输出
  status: 'running' | 'success' | 'failure',
  duration: number|null, // 耗时（ms）
  timestamp: string,   // ISO 时间戳
  timeAgo: number,     // Date.now()
}
```

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `{base}/widget` | Widget 页面（SSR） |
| GET | `{base}/records?limit=&since=` | 查询命令记录 |
| POST | `{base}/record` | Agent 上报命令结果 |
| POST | `{base}/clear` | 清空记录 |
| GET | `{base}/stream` | SSE 实时推送 |

### Agent 上报命令示例

```bash
curl -X POST '{base}/record' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <token>' \
  -d '{
    "command": "apt install -y wireshark",
    "cwd": "/home/user",
    "exitCode": 0,
    "stdout": "Reading package lists... Done\n...",
    "stderr": "",
    "duration": 324
  }'
```

## 工作方式

### 数据获取（双通道）

1. **方案 A（EventBus）**：自动监听 Hanako 的 `command:exec` / `command:result` 事件
2. **方案 B（主动上报）**：Agent 执行命令后调用 `POST /record` 主动上报

### 数据存储

环形缓冲区，默认最多保留 50 条记录，超出自动丢弃最旧记录。

### 实时推送

SSE（Server-Sent Events），Widget 页面打开后自动连接，新记录实时追加。

## 配置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| maxRecords | integer | 50 | 内存保留的最大记录数 |
| autoCollapse | boolean | true | 成功执行的命令自动折叠 |

## 文件结构

```
command-result-panel/
├── manifest.json    # 插件清单
├── index.js         # 主生命周期 + 环形缓冲区 + SSE 广播
├── README.md        # 说明文档
└── routes/
    └── panel.js     # Widget 路由：SSR 页面 + REST API + SSE
```
