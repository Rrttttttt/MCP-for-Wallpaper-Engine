# Wallpaper Engine MCP

Windows 本地 STDIO MCP 服务，用于制作可保存的 Wallpaper Engine 源工程，并通过官方引擎获取运行反馈。支持 Web 创作、基础 Scene 模板、CEF 和自有原生窗口截图；复杂 Scene 作者能力仍待开发。

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
| `devtoolsPort` | 手动配置的本机 CEF 调试端口；`null` 时仍可使用 CLI、工程管理和已构建的原生截图后端 |
| `timeoutMs` | 单次操作等待上限，1000–30000 毫秒 |

本机集成测试要求在正常用户权限下访问引擎。受限沙箱可能使 CEF 无法写入自身配置目录，出现 `ProcessSingleton ... Error code: 5`；这是实际遇到的环境限制。

### 工作区锁诊断

一个工作区只允许一个持有锁的服务会话。锁冲突时，服务仍可完成 MCP 握手；调用 `we_workspace_diagnose`，参数为 `{}`：

```json
{"name":"we_workspace_diagnose","arguments":{}}
```

返回 `workspace`、`mode`、`lock`、`holder` 和 `recovery`。`mode: "owner"` 表示当前会话仍持有原锁；`"diagnostic"` 表示仅可诊断，其余 13 个工具均返回 `WORKSPACE_LOCKED`。原锁发生变化或不可读时，原持有会话的普通操作返回 `WORKSPACE_OWNERSHIP_LOST`，不会自动解锁。

新锁在 `server.lock/owner.json` 记录 PID、主机、平台、随机会话标识和进程启动身份。Windows 使用系统自带 PowerShell 只读查询 `Process.StartTime`，无需截图 helper；查询有 3 秒期限。旧空锁、记录损坏、异地主机、权限不足或查询失败均保持 `holder.state: "unknown"`。`"alive"`、`"exited"`、`"pid-reused"` 是采样时的身份核对结果；其中 PID 复用表示启动时间不匹配，不是只凭 PID 推断。`lock.fingerprint` 可用于识别两次诊断间的变化，不授予解锁权限。

**受控恢复尚未实现**，`recovery.available` 固定为 `false`。即使持有者显示退出，诊断会话也不会取得写入权；原服务正常退出释放锁后，需要重新启动会话才能尝试获取锁。不要按锁的年龄或空目录直接删锁。旧空锁缺少历史归属信息，本接口不能补造所有权证据。

诊断只访问配置指定的工作区，不接受任意路径或 PID，不终止进程，不接管旧预览。元数据读取限制为 8 KiB，链接、额外硬链接及异常目录内容被拒绝或保守报告；非 Windows 的进程身份查询尚未实现。`--probe` 仍只用于引擎环境探测，不能代替此 MCP 工具。实测范围与后续恢复边界见 [锁诊断记录](docs/workspace-lock-incident.md)。

### 可选原生窗口截图

原生截图需要 Windows x64、.NET 10 x64 运行时；构建另需 .NET 10 SDK。本机验证使用 SDK 10.0.301、Windows 11 build 26100 和引擎 2.8.42。其他系统尚未实测。Windows SDK 投影版本固定为 10.0.19041.57。

```powershell
npm.cmd run build:native
```

脚本优先使用 `.we-mcp/tools/dotnet/dotnet.exe`，否则使用 PATH 中的 `dotnet`。首次恢复依赖需要访问官方 NuGet；缓存及构建产物均被 Git 忽略。构建后的 `native/WeCapture/bin/publish/` 是完整 helper 目录，部署时须连同 DLL、runtimeconfig 和许可证一起保留；无需在运行机器安装 SDK。服务不会自动下载或安装 SDK。

helper 存在时，预览启动、调参、截图和关闭均增加窗口归属校验：启动前 HWND 基线、唯一生成的窗口名、同一会话、引擎可执行文件路径、PID、创建时间和窗口类。身份不符即拒绝，关闭后还须确认原 HWND 和名称消失；失败保留记录。未构建 helper 时继续使用原有 CLI/CEF 能力，但关闭只报告命令已发送。

原生捕获不依赖 CEF，使用 Windows Graphics Capture，仅针对绑定窗口；没有桌面或显示器截图兜底。最小化、隐藏、尺寸变化、超时均有明确错误。采用每监视器 DPI 感知，返回实际物理像素尺寸及 DPI；原生图像包含标题栏和窗口边框，尺寸可大于请求的客户区尺寸。帧限制为 16777216 像素、单边 8192、PNG 20 MiB，图像内嵌总量限制为 8 MiB base64。

颜色路径为 SDR BGRA8；HDR 色彩保真、多屏混合 DPI、4K 和长时间压力场景尚未验收。PNG 成功或连续帧不同都不能独立证明画面正确或美观。Scene 的运行时脚本/素材健康也不能由原生截图推导。

复用说明：独立 helper 的 COM/D3D 互操作改编自 [Backdrop for Codex](https://github.com/TogawaSakiko-desuwa/backdrop-for-codex)，保留 Apache-2.0 许可证与 NOTICE；单帧流程另参考 [Win32CaptureSample](https://github.com/robmikh/Win32CaptureSample)。详见 [helper 归属声明](native/WeCapture/THIRD-PARTY-NOTICES.md)。没有引入两者的完整应用或替代官方播放器。

## 工具

| 工具 | 行为 |
| --- | --- |
| `we_workspace_diagnose` | 即使锁冲突也可读取配置工作区的锁指纹、持有者记录和进程身份；不恢复、不删除锁 |
| `we_environment_probe` | 返回版本、CEF 发现状态和未验证能力，不修改引擎设置 |
| `we_project_list` | 在配置目录内有界发现工程，去重并分页 |
| `we_project_inspect` | 返回源码 revision、元数据、文件哈希；可用 `readFiles` 读取文本 |
| `we_project_create` | 用 `web-starfield` 或 `scene-orbit` 创建工程，或用 `sourceProjectId` 导入受管副本；移除旧 workshopid |
| `we_project_apply` | 按 `expectedRevision` 写入 UTF-8 文件或删除文件，先静态检查并保存检查点 |
| `we_project_restore` | 恢复指定检查点，校验归属、内容哈希和当前 revision |
| `we_project_validate` | 检查 JSON、入口、HTML/CSS 引用、音频开关及 Scene 本地图片层依赖；不冒充真实引擎验证 |
| `we_preview_open` | 从固定源码副本打开唯一命名窗口；每个服务会话最多登记一个 Web，Scene 可共存；返回就绪证据或未验证状态 |
| `we_preview_set_properties` | 校验类型及范围后修改该预览的公开参数，不修改源码默认值 |
| `we_preview_move_mouse` | 向自有 Web CEF 预览派发鼠标移动；`x/y` 为 0～1 的归一化坐标，左上 `(0,0)`、右下 `(1,1)`；不移动系统光标 |
| `we_preview_observe` | 采集 1–3 张 PNG；默认只返回文本诊断和文件路径；`includeImages:true` 才附带有界图像内容；`backend:auto/cef/native` 选择捕获路径 |
| `we_preview_close` | 只关闭本服务创建的预览窗口，不发送全局 stop 或 kill |
| `we_publish_prepare` | 复制运行工程到发布暂存目录并输出剩余步骤，不打包 `.pkg` 或上传 |

## 一次创作循环

1. 用 `we_project_create` 创建 `managed/my-wallpaper`。当前模板支持速度、密度、音频开关、星体颜色，运行文件无网络依赖。
2. 用 `we_project_inspect` 获取 revision 与源码；调用 `we_project_apply` 时传入该 revision。`content: null` 表示删除，其他值是文件的完整新内容。
3. 打开预览并调用 observe；默认只返回文本和原图路径，适合无多模态模型的 CLI。多模态客户端可显式传 `includeImages:true`。`backend:auto` 优先使用已连接 CEF，否则选择原生后端；没有可用后端则返回错误。
4. 临时调参后，把满意的值写入 `project.json` 的 `general.properties`，再打开新的预览；Web 须先关闭现有 Web 预览。已有预览始终指向原来的固定源码副本。
5. `we_preview_observe` 的 `reload: true` 会关闭并重开这个预览窗口，从同一源码副本重新初始化宿主。运行参数会恢复为该副本的源码默认值。
6. 通过多帧检查后执行发布准备，检查预览图、动态资源、素材权利和元数据，再用官方编辑器导入、发布。

版本冲突返回 `REVISION_CONFLICT`，应重新 inspect 后再修改。成功修改返回 `checkpointId`；无变化的调用返回 `checkpointId: null`。错误通过 MCP `isError` 和结构化错误代码返回。

鼠标移动使用当前页面 `innerWidth/innerHeight`（每边 1～8192 CSS 像素）按 `x*(width-1)`、`y*(height-1)` 换算，不使用含标题栏的原生截图尺寸。仅支持配置 CEF 调试的 Web 预览，Scene 或无调试端口返回 `MOUSE_INPUT_UNSUPPORTED`；目标缺失、歧义或跳转会拒绝。不提供点击、滚轮、键盘或系统光标回退。输入前后校验页面归属，并沿用可用的原生窗口身份校验。

返回 `confirmation: "event-dispatched"` 仅表示 CDP 命令已确认；`visualResponse: "unverified"` 提醒继续 observe 检查画面。检查和派发不是原子操作：期间跳转、调整大小或连接失败可能发生在事件已发出之后，此类错误带 `dispatchAttempted: true`，不保证事件未被接收。本机官方引擎 2.8.42 已通过命令冒烟检查和几何双眼样例验收：页面接收坐标、截图中的方向/幅度/遮罩边缘、原生窗口位移，以及每次调用前后的系统光标位置均有测量。样例通过不代表任意作品的视觉质量通过。调研依据见 [鼠标输入研究](docs/mouse-input-research.md)。

运行 `node scripts/verify-mouse.mjs` 可重现双眼验收，约一分钟保持系统鼠标不动；报告位于 `.we-mcp/mouse-verification/report.json`。脚本使用一个 Web 和一个静止 Scene 对照，顺序测试两种 Web 尺寸；详细范围见 [鼠标实机验收记录](docs/mouse-input-acceptance.md)。

**两个 Web 同时渲染的本机故障尚未修复**：绕过 MCP、改变等价 CLI 参数、关闭远程调试均未消除第二个 Web 渲染失败。现有证据最符合 CEF 根目录单例行为，但没有直接确认宿主内部实现。服务因此在 CLI 和快照写入之前返回 `WEB_PREVIEW_LIMIT`，列出须先关闭的 `activePreviewIds`；`we_environment_probe` 的 `webPreviewConcurrency` 也公开此限制。关闭失败时仍保留名额，正常关闭后可重开；Scene 可共存。这是**服务会话内限制，不是跨进程互斥**，不能防止其他服务或手动启动的 Web 触发同一引擎故障。服务不会自动更改 CEF 配置、关闭已有预览或退回系统鼠标。[对照证据与源码依据](docs/cef-concurrency-research.md)。

`node scripts/verify-web-limit.mjs` 验证第二个 Web 被拒绝后没有新快照或调试目标、第一个仍能接收鼠标输入，以及关闭后能在 Scene 仍打开时重开 Web。报告位于 `.we-mcp/web-limit-verification/report.json`；这验证限制行为，不代表并发 Web 已通过。

## 基础 Scene 模板

`we_project_create` 传入 `templateId: "scene-orbit"` 可创建 1280×720 Scene：一个原创青色图片层在深色背景上水平运动。`properties` 支持 `speed`（0–2，圈/秒）和 `amplitude`（0–400，场景像素）；幅度为 0 时回到中点，速度为 0 时保持当前相位。图案 PNG、`.tex-json` 编译配置和 `.tex` 产物均随工程保存，没有网络素材依赖。

Scene 的 Origin 属性内联绑定 SceneScript，源码位于 `scene.json` 的 `objects[0].origin.script`。脚本通过 `engine.frametime` 累积相位，从 `engine.userProperties.speed/amplitude` 读取当前值，不逐帧叠加位置。不要把 Web 的 `window.wallpaperPropertyListener` 搬到 Scene 中。

模板结构已由本机官方编辑器 2.8.42 打开、保存并回读，最终脚本保持不变；官方引擎独立窗口已实测图片、连续运动、幅度归零/恢复和速度归零。当前实现使用直接属性读取，是因为本机实测仅依赖 `applyUserProperties` 回调时参数未生效；没有把该观察外推为所有版本的回调行为。

基础模板还已完成编辑、回滚与重开闭环验收：同时修改 `project.json` 的源码默认参数和 `scene.json` 的 Origin/脚本，实际画面从横向变为纵向运动；旧预览重载仍使用旧副本，源码回滚也不会改写运行中的新版副本。重新打开工程后，源码 revision、各源文件 SHA-256（包括 PNG/TEX）与原版一致，画面恢复横向运动。临时参数在同一副本重载后恢复源码默认值。检查的是原始源文件，渲染器在私有副本中新生成的 shader 缓存不属于该源码清单。

验收另覆盖过期 revision 的编辑/恢复拒绝、同时带新旧两个活动预览退出 MCP 服务后的窗口/锁回收，以及重启 MCP 服务后从持久检查点恢复两个源码版本。这里重启的是 MCP 服务进程；未覆盖强制杀进程、Wallpaper Engine 本体重启或整机重启后的恢复。

模板自带 TEX，创建和预览无需再次编译。修改源 PNG 或编译配置后，可重新生成模板纹理：

```powershell
npm.cmd run build:scene-assets
```

此开发脚本读取本机配置中的 `installDir`，调用官方 `bin/resourcecompiler64.exe -tex -i ... -o ...`。它在独立临时工程中编译，通过头部和尺寸限制检查后才替换模板 TEX，并输出编译器、源图与产物 SHA-256。松散 PNG 在本机曾使编译器超时，所以保留完整工程和 `materials` 目录布局。编译器未随仓库分发；该调用方式仅在当前安装版本验证。脚本更新的是仓库模板，不会自动更新已经创建的工程副本。

Scene 静态检查返回 `sceneDependencies`，遍历本地 `image → model.material → passes.textures → TEX`，检查危险路径、TEX 头部和“有源图但缺少编译纹理”的情况。安装目录共享资产无法仅从工程内容确认，因此未解析引用保留为警告；`valid: true` 不表示所有依赖完整或脚本正确。检查上限为 2000 对象/引用、每材质 64 pass、每 pass 32 纹理，超限明确告警。粒子、3D 模型、自定义 shader、动态资产和完整 TEX 解码尚不在静态检查范围内。

`scene-orbit` 使用引擎自带 `genericimage4` shader，离线运行仍依赖已安装的官方引擎。模板不含第三方壁纸图片、工坊 ID 或外部播放器代码。

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

构建原生 helper 后，运行 `node scripts/verify-native.mjs`，验证无 CEF 的原生截图、默认纯文本返回、显式图像块、多帧变化、重载、真实窗口消失，以及篡改身份、伪造同名窗口、最小化、窗口改名和查找超时的拒绝行为。报告位于 `.we-mcp/native-verification/report.json`。此脚本会短暂打开本轮创建的测试窗口，只操作这些窗口；必须在正常交互用户会话中运行。

`node scripts/verify-scene.mjs` 通过真实 STDIO MCP 创建新 Scene 工程，以纯文本模式采集原生截图，测量图案的青色像素位置，验证实际运动、参数响应、编辑/回滚/重开、固定副本隔离及服务重启后的持久检查点。它会启动两个先后运行的 MCP 服务，测试正常退出时的窗口和锁回收；异常清理失败也会令脚本失败。报告位于 `.we-mcp/scene-verification/report.json`，包含调用、测量、文件哈希校验与服务进程记录。检查图案位置而非仅比较整张 PNG，避免把标题栏变化当作动画；这仍不是通用画面质量评价或 Scene 错误收集。

`.we-mcp` 和本机配置不会进入 Git。应单独备份受管源工程；工坊上传不能替代源工程备份。锁冲突时先通过 `we_workspace_diagnose` 保留并核对证据，当前没有自动回收或强制解锁工具。`active-previews.json` 记录了预览窗口名称，便于异常退出后核对；它不证明窗口已不存在，也不授予新会话控制旧窗口的权限。

多文件写入不具备跨进程原子性：服务会序列化调用、检查写入前后的哈希，并保存 checkpoint 和 operation journal。中途遇到错误返回 `RECOVERY_REQUIRED`，保留现场；重新 inspect 后可用检查点恢复。外部编辑器不应同时写同一受管工程。

首版限制：工程上限 64 MiB / 2000 文件，单次文本读取 256 KiB，单文件文本修改 1 MiB。拒绝隐藏路径、node_modules、Windows 特殊文件名和符号链接/目录联接；因此应导入运行工程目录，而不是含开发依赖的仓库根目录。运行产生的历史副本和截图暂不自动清理。

当前四步目标（复用调研、原生捕获、基础 Scene 模板、Scene 编辑/回滚/重开闭环）已完成本机验收。尚未完成复杂 Scene 工具、通用 Scene 脚本/素材错误收集、真实系统音频和媒体会话验收、通用 UI 自动化及工坊上传。基础 Scene 模板通过不代表任意 Scene 作者工作流已验收。静态依赖检查不能穷尽任意 JavaScript/Scene 动态引用；发布准备仍需检查预览图和依赖。

接口依据：[官方 CLI](https://help.wallpaperengine.io/en/functionality/cli.html)、[Web 属性](https://docs.wallpaperengine.io/en/web/customization/properties.html)、[音频](https://docs.wallpaperengine.io/en/web/audio/visualizer.html)、[调试入口](https://docs.wallpaperengine.io/en/web/debug/debug.html)、[官方 MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)。版本兼容结论以本仓库的本机实测记录为准。

Scene 依据：[官方 SceneScript 引用与类型定义](https://docs.wallpaperengine.io/en/scene/scenescript/reference.html)、[IEngine 属性](https://docs.wallpaperengine.io/en/scene/scenescript/reference/class/IEngine.html)、[update 与帧时间](https://docs.wallpaperengine.io/en/scene/scenescript/reference/event/update.html)、[开发者公开的资源编译命令](https://steamcommunity.com/app/431960/discussions/2/340412122401455740/)。新增实现使用当前安装版编辑器保存结果与实际编译/运行证据，没有依赖第三方播放器的兼容性声明。
