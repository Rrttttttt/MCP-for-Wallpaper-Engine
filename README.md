# Wallpaper Engine MCP

Windows 本地 STDIO MCP 服务，用于制作可保存的 Wallpaper Engine 源工程，并通过官方引擎获取运行反馈。当前完成 Web 创作工作流的第一版；原生 Scene 作者能力尚未通过验收。

## 启动

要求 Windows、Node.js 24 或更高版本，以及正在运行的官方 Wallpaper Engine。工程管理和自动测试可脱离引擎运行。

```powershell
npm.cmd ci
npm.cmd test
Copy-Item we.config.example.json we.config.json
# 按本机环境编辑 we.config.json
node dist/index.js --probe
node dist/index.js
```

服务的 stdout 只用于 MCP 协议，日志写入 stderr。`--probe` 是单独的诊断模式，会输出 JSON 后退出。

任意支持 STDIO 的 MCP 客户端可使用以下启动参数；将路径替换为实际仓库目录：

```json
{
  "command": "node",
  "args": [
    "D:/CodeX Workstation/MCP for Wallpaper Engine/main/dist/index.js",
    "--config",
    "D:/CodeX Workstation/MCP for Wallpaper Engine/main/we.config.json"
  ]
}
```

默认配置位于程序所在仓库的 `we.config.json`，相对路径基于配置文件所在目录解析。不会依赖 MCP 客户端当前目录。

| 配置 | 含义 |
| --- | --- |
| `installDir` | 官方引擎安装目录，包含 wallpaper32.exe 或 wallpaper64.exe |
| `workspace` | 受管工程、检查点、预览副本、截图和发布暂存目录；默认 `.we-mcp` |
| `projectRoots` | 额外只读工程目录；可以是工程本身或其父目录；不扫描整盘 |
| `devtoolsPort` | 手动配置的本机 CEF 调试端口；`null` 时只提供 CLI 和工程能力 |
| `timeoutMs` | 单次操作等待上限，1000–30000 毫秒 |

本机集成测试要求在正常用户权限下访问引擎。受限沙箱可能使 CEF 无法写入自身配置目录，出现 `ProcessSingleton ... Error code: 5`；这是实际遇到的环境限制。

## 工具

| 工具 | 行为 |
| --- | --- |
| `we_environment_probe` | 返回版本、CEF 发现状态和未验证能力，不修改引擎设置 |
| `we_project_list` | 在配置目录内有界发现工程，去重并分页 |
| `we_project_inspect` | 返回源码 revision、元数据、文件哈希；可用 `readFiles` 读取文本 |
| `we_project_create` | 用 `web-starfield` 创建工程，或用 `sourceProjectId` 导入受管副本；移除旧 workshopid |
| `we_project_apply` | 按 `expectedRevision` 写入 UTF-8 文件或删除文件，先静态检查并保存检查点 |
| `we_project_restore` | 恢复指定检查点，校验归属、内容哈希和当前 revision |
| `we_project_validate` | 检查 JSON、入口、HTML/CSS 本地引用和音频开关；不冒充真实引擎验证 |
| `we_preview_open` | 从固定源码副本打开唯一命名窗口，返回就绪证据或未验证状态 |
| `we_preview_set_properties` | 校验类型及范围后修改该预览的公开参数，不修改源码默认值 |
| `we_preview_observe` | 返回 1–3 张 PNG 图像、文件路径、固定诊断对象及有界日志；可重开宿主进行复验 |
| `we_preview_close` | 只关闭本服务创建的预览窗口，不发送全局 stop 或 kill |
| `we_publish_prepare` | 复制运行工程到发布暂存目录并输出剩余步骤，不打包 `.pkg` 或上传 |

## 一次创作循环

1. 用 `we_project_create` 创建 `managed/my-wallpaper`。当前模板支持速度、密度、音频开关、星体颜色，运行文件无网络依赖。
2. 用 `we_project_inspect` 获取 revision 与源码；调用 `we_project_apply` 时传入该 revision。`content: null` 表示删除，其他值是文件的完整新内容。
3. 打开预览并调用 observe；模型可直接读取 MCP 图像内容，用户也可查看保留的原图。
4. 临时调参后，把满意的值写入 `project.json` 的 `general.properties`，再打开新的预览。已有预览始终指向原来的固定源码副本。
5. `we_preview_observe` 的 `reload: true` 会关闭并重开这个预览窗口，从同一源码副本重新初始化宿主。运行参数会恢复为该副本的源码默认值。
6. 通过多帧检查后执行发布准备，检查预览图、动态资源、素材权利和元数据，再用官方编辑器导入、发布。

版本冲突返回 `REVISION_CONFLICT`，应重新 inspect 后再修改。成功修改返回 `checkpointId`；无变化的调用返回 `checkpointId: null`。错误通过 MCP `isError` 和结构化错误代码返回。

## CEF 与当前版本差异

公开调试文档描述了端口设置入口，但本机 `2.8.42` 已把它换成内置 DevTools 按钮。本次经用户允许，在原有 `cefcommandline` 设置中配置以下参数并重启后，实测可连接：

```text
--remote-debugging-port=9223 --remote-debugging-address=127.0.0.1
```

服务本身不会改这些设置。`we.config.json` 的 `devtoolsPort` 必须与引擎实际端口一致。本机已确认监听地址为 `127.0.0.1`，未把此结果推断为其他版本保证。

直接使用 `Page.reload` 在本机丢失了宿主属性和 FPS 回调，因此实现改为重建自有预览窗口。CLI 的 `RAW~(...)~END` JSON 需要保留 Windows 原始引号；实现仅对固定的属性命令使用原始参数模式，并拒绝保留分隔符，全程不经过 shell。

## 测试与状态数据

```powershell
npm.cmd test
# 下面会实际打开并回收独立预览；先配置安装目录和 CEF 端口
node scripts/verify-engine.mjs
```

普通测试覆盖路径边界、链接、只读来源、检查点、并发版本冲突、Windows 参数、属性回调、限帧、CEF 超时/断线/日志及真实 STDIO 握手。集成脚本另验证实际画面、多帧变化、参数接收、源码 revision、宿主重载和发布准备，详细报告写入 `.we-mcp/integration-report.json`。

`.we-mcp` 和本机配置不会进入 Git。应单独备份受管源工程；工坊上传不能替代源工程备份。一个工作区只允许一个服务进程；崩溃留下 `server.lock` 时，先确认旧进程已退出，再移除这个空锁目录。`active-previews.json` 记录了预览窗口名称，便于异常退出后人工回收。

多文件写入不具备跨进程原子性：服务会序列化调用、检查写入前后的哈希，并保存 checkpoint 和 operation journal。中途遇到错误返回 `RECOVERY_REQUIRED`，保留现场；重新 inspect 后可用检查点恢复。外部编辑器不应同时写同一受管工程。

首版限制：工程上限 64 MiB / 2000 文件，单次文本读取 256 KiB，单文件文本修改 1 MiB。拒绝隐藏路径、node_modules、Windows 特殊文件名和符号链接/目录联接；因此应导入运行工程目录，而不是含开发依赖的仓库根目录。运行产生的历史副本和截图暂不自动清理。

尚未完成原生窗口截图、Scene 模板验收、真实系统音频和媒体会话验收、UI 自动化及工坊上传。静态依赖检查不能穷尽任意 JavaScript/Scene 动态引用；发布准备仍需检查预览图和依赖。

接口依据：[官方 CLI](https://help.wallpaperengine.io/en/functionality/cli.html)、[Web 属性](https://docs.wallpaperengine.io/en/web/customization/properties.html)、[音频](https://docs.wallpaperengine.io/en/web/audio/visualizer.html)、[调试入口](https://docs.wallpaperengine.io/en/web/debug/debug.html)、[官方 MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)。版本兼容结论以本仓库的本机实测记录为准。
