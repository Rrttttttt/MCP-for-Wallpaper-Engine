# 双 Web 预览与 CEF 并发：一手资料核查

日期：2026-10-21。范围为诊断资料与只读本机版本核查；本研究未运行引擎、改生产代码或引擎配置。运行实验由主代理单独记录。

## 当前证据与结论强度

主代理已有实机记录：首个 Web 预览可连接，第二个窗口存在但没有工程对应的 CEF 目标；第一个调试端点新增形似 IPC/位置参数的 HTTP 页面。仅靠端口占用不能充分解释参数成为网页；最优先假设是 CEF ProcessSingleton 将第二次应用启动转发至第一个实例。这是有源码支持的推断，尚不是本机根因已证实的结论。

只读 `F:/SteamLibrary/steamapps/common/wallpaper_engine/bin/libcef.dll` 的版本资源得到 `146.0.11+g3a0fcf1+chromium-146.0.7680.179`。这不是根据 Wallpaper Engine 版本号猜测 CEF 版本。

主代理随后在唯一自有诊断页的 `chrome://version` 读取到 Chromium `146.0.7680.179`，profile 为 `F:/SteamLibrary/steamapps/common/wallpaper_engine/ui/wpcache/monitor200/base/Default`。这表明该实例使用 Wallpaper Engine 专属 monitor200 路径，而非 CEF 默认目录；尚未单凭一个页面证明第二个实例的有效根路径相同。后续需比较 `-location` 等官方参数是否影响这一实例分配，不预设 `--user-data-dir` 能覆盖宿主已设值。

## 官方机制

CEF 头文件说明，从 CEF 120 起，相同 `root_cache_path` 用于进程单例锁，以避免多个应用实例同时写同一目录造成损坏。`cache_path` 为空的内存配置仍不代表根目录不存在。Windows 默认根路径是用户 LocalAppData 下的 `CEF/User Data`。[CefSettings 定义](https://github.com/chromiumembedded/cef/blob/master/include/internal/cef_types.h)

`OnAlreadyRunningAppRelaunch` 的正式契约是：相同根目录再次启动时，参数被转发给已运行的应用，新实例提前退出；默认处理会创建默认样式 Chrome 窗口。正确宿主应检查 `CefInitialize` 是否提前返回，并实现所需的重启行为。与本机库标识对应的提交也包含该契约。[版本对应头文件](https://github.com/chromiumembedded/cef/blob/3a0fcf1/include/cef_browser_process_handler.h)

CEF 官方维护者曾用示例程序记录相同默认根目录导致的单例现象；CefSharp 的维护者进一步说明，多个完全独立的实例需要不同根目录，多个窗口也可以由同一应用进程负责。这些是集成方式的约束，不是调整 CDP URL 过滤规则即可解决的问题。[CEF #3615](https://github.com/chromiumembedded/cef/issues/3615)、[CEF #3609](https://github.com/chromiumembedded/cef/issues/3609)、[CefSharp #4668](https://github.com/cefsharp/CefSharp/issues/4668)

## 开关逐项核查

| 候选 | 已核实事实 | 对本项目的意义 |
| --- | --- | --- |
| `CefSettings.root_cache_path` | 原生 CEF 初始化字段；要求绝对路径。 | 正式修复入口在宿主初始化中。本项目没有 Wallpaper Engine 的该层源码。 |
| `--user-data-dir=...` | `resource_util::GetUserDataPath` 先采用非空 `settings.root_cache_path`，为空才读该开关。 | 只有宿主未固定根目录时才可能覆盖；不能保证 Wallpaper Engine 接受。把一个固定目录加入全局 CEF 参数也不会自动变成每个预览的独立目录。 |
| `--root-cache-path=...` | 已查标准开关与初始化源码没有找到同名通用开关契约；同名 CEF 字段不构成 CLI 证据。 | 不建议把它当已支持的解决方案。 |
| `--disable-process-singleton` | 未在已查 CEF 标准开关与官方接口中找到可依赖的支持证据。 | 不建议盲试后声称已关闭单例。保护目录的一致性约束也不应被绕过。 |
| `--disable-chrome-runtime` | CEF 官方迁移说明中是 125～127 时代示例程序切换旧 Alloy bootstrap 的选项；M128 已删除该 bootstrap。 | 本机 CEF 146 不能依赖旧版本技巧。 |
| `--use-alloy-style` | 选择 Alloy 浏览器样式，仍可使用 Chrome bootstrap；不是进程单例开关。 | 不能把样式切换当作独立应用实例隔离。 |
| `--remote-debugging-port=0` | 官方当前头文件支持选择临时端口，向 stderr 输出端点；存在 cache 路径时还写 `DevToolsActivePort`。 | 只能解决多个独立调试服务器的端口分配；不能单独解决根目录单例。现有服务仅配置一个已知 loopback 端口，不能因此直接宣称支持多端口。 |

源码依据：[根路径读取与覆盖](https://github.com/chromiumembedded/cef/blob/master/libcef/common/resource_util.cc)、[6533 分支同一优先级](https://github.com/chromiumembedded/cef/blob/6533/libcef/common/resource_util.cc#L79-L100)、[CEF 自有开关列表](https://github.com/chromiumembedded/cef/blob/master/libcef/common/cef_switches.cc)、[Alloy bootstrap 删除与样式区别](https://github.com/chromiumembedded/cef/issues/3685)、[远程调试端口契约](https://github.com/chromiumembedded/cef/blob/master/include/internal/cef_types.h)。未找到开关不是对所有私有构建作不存在证明，而是没有足以作为产品接口的证据。

## Wallpaper Engine 的公开边界

官方 CLI 明确允许多个独立窗口，要求各自使用唯一窗口名；当前 MCP 的 `openWallpaper`、`-playInWindow`、`-width`、`-height` 路径与此一致。已查公开参数没有每个预览独立的 CEF 参数、根 cache/profile 或浏览器调试端口。不能凭 CLI 未记载就断言不存在私有能力，也不能直接将 Chromium 开关附到主进程命令上并假定它会转给 Web 宿主。[官方 CLI](https://help.wallpaperengine.io/en/functionality/cli.html)

Wallpaper Engine 开发者在 2026 年社区讨论中确认调试系统曾整体调整，部分系统可能有故障；它说明需要本机验证，但不解释当前故障的根因。[开发者回复](https://steamcommunity.com/app/431960/discussions/2/569289747256649392/)

## 开源实现的可复用范围

GitHub API 在本会话 TLS/认证连接失败，下列 Star 为网页显示值，不是精确实时 API 统计。只查看了必要源码/元数据，没有克隆或构建新播放器。

| 项目 | Star / 许可证 / 技术栈 | 维护与可复用内容 |
| --- | --- | --- |
| [chromiumembedded/cef](https://github.com/chromiumembedded/cef) | 约 4.8k；BSD 三条款；C++ | [提交列表](https://github.com/chromiumembedded/cef/commits/master/)有 2026-09-10 记录。直接采用它的宿主初始化/单例契约解释故障；不复制或替换已安装的运行库。[许可证](https://github.com/chromiumembedded/cef/blob/master/LICENSE.txt) |
| [cefsharp/CefSharp](https://github.com/cefsharp/CefSharp) | 约 10.3k；BSD 三条款；C# / C++、WPF / WinForms | [发布页](https://github.com/cefsharp/CefSharp/releases)包含 2026-08-29 的 v151.3.240；其 #4668 是维护者对同类问题的解释。没有必要引入整个 .NET 浏览器包装层。[许可证](https://github.com/cefsharp/CefSharp/blob/master/LICENSE) |
| [chromiumembedded/cef-project](https://github.com/chromiumembedded/cef-project) | 208；BSD 三条款；C++、CMake / Bazel | 官方可构建对照项目，可在必要时用来比较宿主初始化；本研究未核定其最近默认分支提交日期，未下载安装。[许可证](https://github.com/chromiumembedded/cef-project/blob/master/LICENSE.txt) |

决策：保留现有 TypeScript MCP 与官方引擎，先做受控实验。以上项目提供解释和对照路径，不能替代 Wallpaper Engine 的专有宿主行为；不为修复一个调试故障重建播放器。

## 最小可证伪实验

1. 绕过 MCP，使用同样的两个唯一窗口名与源副本直接调用官方 CLI。若仍出现参数 HTTP 页，MCP 传输与 SDK 会话不是必要条件；仍需保留原生窗口归属和清理证据。
2. 用唯一自有页面读取 `chrome://version` 的 profile 路径作为诊断，或核对实际渲染进程参数/锁路径。若两个根路径相同且第二次启动转发参数，支持单例假设；若根路径已不同，应优先转向宿主启动或引擎错误。该导航仅限测试进程，不扩展公开 MCP 任意执行接口。
3. 在有备份与恢复计划的本机受控实验中，只改变一个得到源码支持的配置变量；确认运行进程实际采用值，不以配置文件写入或进程退出码作为成功。若不同 profile 根路径已证实生效而同端口只导致第二个调试端点失败，端口问题才可与单例问题分开。
4. 无法通过公开接口获得安全、独立的浏览器实例时，应明确报不支持或限制并发，并保留可重现记录。不要连接参数生成的 HTTP 页、关闭其他用户的 CEF 页面、关闭沙箱、删除共享 profile 或注入系统鼠标来让测试通过。

通过标准仍是两个受管 Web 页面各自收到目标鼠标事件、非目标页面事件计数与实际画面不变，以及窗口、服务锁和登记均正常回收。配置目录或端口变化本身不代表该标准通过。

## 本机受控对照结果与产品边界

以下实验由主代理执行，本研究只核对报告并记录结论。绕过 MCP 直接调用 `Engine.open` 仍复现第二个 Web 无匹配目标、启动参数成为 HTTP 页面；分别只追加与窗口名相同的 `-location`、将工程入口从 `project.json` 改为等价的 `index.html`，结果也均未改善，清理错误均为 `[]`。这些对照不能提供独立 profile 初始化能力。

随后临时移除全局远程调试参数并重启引擎，只用原生窗口 PNG 检查双 Web 渲染。第一轮受隐藏/最小化窗口影响，不作为结论。第二轮恢复自有窗口可见性后，第一窗口左右虹膜像素为 `2296/2296`，第二窗口为 `0/0`，双窗口渲染断言失败；报告记录 `flagsRestored: true`、`cleanup: []`。[本机原始报告](../.we-mcp/cef-debug-off/5c324ffd-b87c-400b-b709-ba68add5bdcb/report.json) 属于本地诊断产物，不作为远端仓库中必然存在的附件。

第二轮说明：远程调试端口冲突不是该双 Web 渲染故障的必要条件；它不证明所有机器、所有版本都存在同一故障，也没有直接测得第二个实例的有效根路径。结合参数转为页面及官方单例契约，ProcessSingleton 仍是最符合现有证据的解释，尚未达到直接确认宿主内部根因的程度。

当前已记录的公开 CLI 没有逐预览 CEF profile 参数；在没有宿主源码或受支持入口的情况下，本项目没有已验证的安全目录隔离方案。本次最小防护在每个服务实例已登记 Web 时返回 `WEB_PREVIEW_LIMIT`，发生在调用 CLI、创建快照前；关闭失败保留名额，正常关闭后释放，Web 与 Scene 混合预览仍可走已有路径。该防护是本机已知故障下的保守能力边界，不是修复上游 CEF/Wallpaper Engine，也不承诺多个 MCP 进程间的全局互斥或并发 Web 支持。

## 防护验证

`npm.cmd test` 构建及 14 项测试通过，包括拒绝前无可执行文件查找、无新快照、无 CLI，大小写元数据不绕过限制、关闭失败保留名额、关闭后释放以及 Scene 不占 Web 名额。

`node scripts/verify-web-limit.mjs` 通过真实 STDIO MCP 验证：第二个 Web 明确被拒绝，现有快照和 CEF 目标清单不变，第一个页面仍能接收鼠标输入；关闭第一个后，可以在 Scene 仍打开时重开 Web。报告为 `.we-mcp/web-limit-verification/report.json`，包含清理与锁释放检查。本测试的成功标准是防止当前服务触发已知故障，不是让原始双 Web 渲染断言变绿。
