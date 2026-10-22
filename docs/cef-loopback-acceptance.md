# CEF 双回环地址修复与验收

日期：2026-10-22。环境：Windows、Wallpaper Engine 2.8.42、CEF/Chromium 146.0.7680.179、Node 24.15.0。本轮只处理审计中的 CEF 目标缺失，不包含素材导入、超分或 JavaScript 静态语法检查。

## 复现与根因

输入为本地 `capability-audit-web-starfield-1792666436520/CAPABILITY-AUDIT.md` 及其 runtime JSON。用独立工作区通过真实 STDIO MCP 打开该工程，成功绑定原生窗口，但 `we_preview_observe backend:cef` 返回 `CEF_TARGET_UNAVAILABLE`。两次初始复现均失败，关闭窗口并释放锁正常。

最小复现命令为 `node .we-mcp/diagnose-cef.mjs`；临时探针已删除，保留 JSON 证据。修复前报告位于 `.we-mcp/cef-diagnosis/62baa7d9-6edc-43ed-9cba-28e2d6d3707c/report.json`；带进程和双地址证据的报告位于 `.we-mcp/cef-diagnosis/2c0df2f6-32fb-45c9-9472-467461b4fc20/report.json`。这些是本地忽略的诊断产物，远端仓库不包含它们。

按“固定端口被桌面占用”“存在其他调试端点”“入口路径变化”三个假设检查，得到同一时间的证据：

| 对象 | 进程 / 缓存标识 | 监听地址 | `/json/list` |
| --- | --- | --- | --- |
| 当前桌面 Web | `webwallpaper64.exe` PID 43908 / `monitor0` | `127.0.0.1:9223` | 桌面已发布工程，不属于本次预览 |
| 本次自有预览 | `webwallpaper64.exe` PID 25044 / `monitor200` | `[::1]:9223` | 与本次快照目录完全匹配的 `file:` 页面 |

两进程均属于当前官方 `wallpaper32.exe` PID 29300；参数中都带 `--remote-debugging-port=9223 --remote-debugging-address=127.0.0.1`。因此不能由这段配置推定只有 IPv4 监听。此证据确认了本轮漏发现的直接原因，没有证明 CEF 内部选择 IPv6 的全部机制。

原服务只请求 IPv4，且即使 WebSocket URL 是 IPv6 也会强制改为 IPv4，导致查询和连接均无法触及自有预览。IPv6 页面的入口路径没有变化，不需要放松路径保护。本轮未修改引擎配置、重启引擎或替换桌面壁纸。

## 开源与官方资料核查

开发前重新搜索了 GitHub、官方文档和 Steam 社区。下表 Star 为本次网页显示的近似值；提交日期为可见记录，不保证抓取缓存已包含最新提交。

| 项目 | Star / 许可证 / 技术栈 | 维护、可复用范围与决策 |
| --- | --- | --- |
| [ChromeDevTools/devtools-protocol](https://github.com/ChromeDevTools/devtools-protocol) | 约 1.6k / BSD-3-Clause / PDL、JSON、TypeScript 协议定义 | [可见提交](https://github.com/ChromeDevTools/devtools-protocol/commits/master/)包含 2026-09-11；有完整协议文档。采用目标发现和 WebSocket 契约，无须引入协议生成包。 |
| [cyrus-and/chrome-remote-interface](https://github.com/cyrus-and/chrome-remote-interface) | 约 4.6k / MIT / JavaScript、Node.js | [可见提交](https://github.com/cyrus-and/chrome-remote-interface/commits/master/)包含 2026-02-09；提供客户端、目标选择和文档。完整客户端可复用，但本项目已有 CDP 请求、超时和日志实现，迁移不会自动解决地址选择与归属绑定，不新增依赖。 |

[Wallpaper Engine 官方调试说明](https://docs.wallpaperengine.io/en/web/debug/debug.html)解释调试入口，但不能代替本机目标归属验证；[CEF 设置契约](https://github.com/chromiumembedded/cef/blob/master/include/internal/cef_types.h)描述端口和缓存行为。[Steam 社区调试指南](https://steamcommunity.com/sharedfiles/filedetails/?id=974875711)已较旧，仅作检索入口，不作为当前双地址行为的证明。

## 最小改动

- `src/cdp.ts`：同一配置端口并行查询两个固定回环地址；只接受自有工程路径下的唯一 page，记录发现地址。WebSocket 保持在该地址，仍拒绝外部主机、其他端口、凭据及非 `ws:` URL。单个地址未监听可容忍；损坏 JSON、非法列表及响应超限明确拒绝。普通端点探测增加 IPv6 回退。
- `src/engine.ts`：发现地址变化时重建连接，避免仅凭目标 ID 复用旧地址的连接。
- `test/cdp.test.mjs`：修复前新增测试确实失败，错误为 `Owned preview is present only on the IPv6 listener.`；覆盖地址固定、IPv4 回归、跨地址歧义、缺失监听、损坏响应和不安全 WebSocket 拒绝。
- `test/mouse.test.mjs`：原单端点模拟器明确仅在 IPv4 返回页面，IPv6 返回空列表，避免虚构两个相同的监听器。
- `scripts/verify-cef.mjs`：复用 MCP 客户端、CDP、原生归属检查和 PNG 解码器，增加隔离的实机验收。可测试内置星空或现有工程副本，要求本项目的 `__weDiagnostics` 和 `speed` 属性。
- `README.md` 与本文：记录实际地址行为、复现方式、范围和限制。

## 验证

```powershell
npm.cmd test
node --check scripts/verify-cef.mjs
node scripts/verify-cef.mjs
node scripts/verify-cef.mjs '.we-mcp/creations/jianyue/data/projects/capability-audit-web-starfield-1792666436520'
node scripts/verify-cef.mjs '.we-mcp/creations/jianyue/data/projects/jianyue-free-breeze-1792648082229'
```

构建及完整测试通过 45/45，无跳过。实机三种输入均通过以下检查：

1. `page-ready`；双帧 CEF PNG 可完整解码，初始诊断无错误。人工查看新建星空及人物截图，画面正常，非空白。
2. 临时设置 `speed:0.7`，页面诊断回读一致。
3. 左、右和重载后的中心输入，页面收到可信鼠标事件，坐标与请求相差不超过 1 CSS 像素；这是页面事件接收验收，不代表人物眼部方向和边缘质量重新验收。
4. 测试页注入固定控制台错误和异步异常，服务分别收集到 `Runtime.consoleAPICalled`、`Runtime.exceptionThrown`，工程诊断记录异常。此测试操作只存在于脚本内部的自有页，不新增公开任意执行接口。
5. 宿主重载后重新匹配 IPv6 页面、验证当前窗口身份、清除注入异常，并恢复源码默认属性；新鼠标事件和临时属性再次生效。
6. 结束时窗口不存在、登记为空、锁释放，`cleanupErrors:[]`。两个原工程前后 revision 一致。

本地成功报告：

- 新建星空：`.we-mcp/cef-verification/3ae87524-4f23-4521-a9df-8418bc4dedf5/report.json`。
- 审计星空：`.we-mcp/cef-verification/75b6af52-d016-447e-8619-138a9612ab39/report.json`；原工程 revision `0827accf778ff524aeb899ffc6d7d7aaa89d21a8564597c2f7575a0cf1e12d9d`。
- 补充异常响应拒绝检查后的最终代码复验：`.we-mcp/cef-verification/1d4d82a6-7269-41ba-aec0-ed5ffa50d125/report.json`；8 项检查通过，原审计星空 revision 一致，清理无错误；完整测试再次通过 45/45。
- 人物作品：`.we-mcp/cef-verification/90a457b7-6d4e-4c93-9250-6da37ec8c481/report.json`；原工程 revision `b92d8d1040f838af4ae6fe9d173f3f4cc39f8a96504d3b5592d2beafa9f44027`。

验收脚本开发中有两次失败，均保留本地报告：首次仅检查最后事件的断言失败，未记录实收值，无法确定是事件时序、输入干扰还是其他原因；改为有界事件记录并等待指定坐标实际出现，没有修改产品坐标映射。另一次在重载新窗口已启动后按复用名称检查“窗口消失”，属于验收条件错误，已改为验证新窗口身份。最终成功记录不能抹去这些早期实验限制。

## 审查与剩余边界

1. **为什么这样修复？** 双地址监听和自有路径均有实测证据，修复共用发现与连接位置，可覆盖截图、输入、诊断和重载。
2. **有没有更简单的实现？** 只改成 IPv6 会使 IPv4 预览回归；改成 `localhost` 不能稳定区分同端口的不同进程。两个固定地址加原有归属检查已是所需最小范围。
3. **架构与隐藏约束？** 保持同一配置端口、只读发现、自有路径/窗口校验、单会话一个 Web 和明确歧义拒绝。没有扩大到扫描端口、连接桌面目标或改变引擎配置。
4. **临时绕路或技术债？** 没有新增依赖、硬编码进程 ID、工程名或生产注入。验收只覆盖本项目诊断接口，已在 README 明示；诊断临时代码已删除。两个地址均返回匹配目标时保守拒绝，即使看似同一页也不猜测去重。
5. **规模扩大十倍先在哪里受限？** 官方引擎多个 Web 实例的渲染/profile 隔离及固定端口容量仍先受限。查询两个地址不提供任意数量的并发 Web，也没有跨 MCP 进程互斥；保留原有限制，不扩展为新的调度系统。

未验证：本轮未重跑眼部像素方向/幅度/边缘变形及系统光标位置测量、双 Web 并发、第三方任意诊断接口、跨屏 DPI/HDR/4K、其他引擎版本；原生后端本轮只沿用窗口身份与清理检查，没有重跑其整套截图验收。静态 JS 语法检查、二进制素材导入和超分仍待后续独立步骤。

本次改动前基线为 `f1cbf9f`。如需撤销本次行为，应 revert 本次修复提交；不要回滚工作区工程、检查点或当前桌面选择。
