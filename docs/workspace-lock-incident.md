# 工作区锁启动故障：诊断与恢复边界

**当前状态（2026-10-22）：原工作区已原地恢复，原配置可以正常使用。** 依据系统重启与重启前同一锁目录的历史记录完成一次性人工归档，详见文末“原旧空锁的实机恢复”。此前各节描述对应阶段的事实，不能作为当前仍被锁定的结论。原临时客户端卡住的历史根因仍未确认。

2026-10-21，第 1 步，只读诊断。基线提交 `36a60e0`。本文中的 MCP 接口为后续设计，尚未实现；本轮不删除锁、不终止旧进程、不改变服务行为。

## 已确认的事实

- 实际受影响工作区是 `.we-mcp/creations/jianyue/data`，由 `.we-mcp/creations/jianyue/config.json` 指定，**不是**默认 `.we-mcp`。
- `server.lock` 是普通空目录，创建/修改时间均为 `2026-10-21T11:08:59.524Z`。没有 PID、启动时间、主机或所有权令牌。时间只能用于描述，不能证明失效。
- 对该配置通过真实 SDK STDIO 客户端连接，两次均出现 `Projects.init → WORKSPACE_LOCKED → Connection closed`。锁的 dev、ino、birthtime、mtime 和目录条目在每次复现前后相同。
- 19:18 左右（Asia/Shanghai）的提升权限只读 CIM 快照未发现常规 Node、本项目命令行或 Bun/Deno MCP 服务。发现的 `node.exe` 是 artifact-session 宿主；另有多个 `node_repl.exe` 宿主，不能把它们当成本项目服务并清理。快照只描述采样时刻，不是历史所有权证明。
- 该工作区的 `active-previews.json` 当前为 `[]`。这不是操作系统窗口清单，也不能单独证明不存在遗留窗口。
- 结论：**锁存在且启动失败可复现；持有者未知。没有足够证据称为误报或允许自动回收。**

## 可重复的故障信号

从仓库根目录执行本机临时诊断脚本：

```powershell
node .we-mcp/diagnose-workspace-lock.mjs
```

脚本先确认目标锁存在且不是链接，再以该配置启动一个新客户端连接；只关闭自己创建的客户端/子进程，不清理工作区。它断言连接失败、stderr 包含 `WORKSPACE_LOCKED` 与 `Projects.init`、锁前后指纹相同。退出码 0 表示**成功复现故障**，不表示服务已修复。

本地详细结果：`.we-mcp/workspace-lock-incident.json`，未提交运行日志。两次结果约 0.2 秒，均为 `Connection closed`，锁条目仍为空。脚本目前针对本次已存在的锁；后续服务行为改变后应由正式回归测试替代。

控制组：`npm.cmd test` 构建通过，14/14 测试通过，其中真实 STDIO 测试在独立临时工作区正常握手、列出 13 个工具并正常释放锁。没有更改故障工作区的配置来制造成功。

## 当前实现与依赖

| 文件 | 当前职责和影响 |
| --- | --- |
| `src/projects.ts` | `init()` 先创建 projects 目录，再以原子 mkdir 创建空锁目录；EEXIST 统一报 WORKSPACE_LOCKED。`unlock()` 直接 rmdir，没有所有权核验。 |
| `src/index.ts` | 在注册工具和启动 STDIO 之前 await init；启动异常不会进入工具的结构化错误包装。EOF/信号处理正常情况下等待队列、关预览、关 transport、释放锁。 |
| `src/files.ts` | 解析配置、拒绝链接路径、提供 Fault 和原子文件写入，可复用；不是锁管理模块。 |
| `src/engine.ts` | 单会话持有预览身份并写 active-previews 注册表；只读诊断会话不可假装接管上一会话的窗口。 |
| `test/core.test.mjs` | 已测试重复 init 被拒绝；部分测试直接调用未 init 的 Projects 方法，后续加入所有权保护时需同步处理真实调用约束。 |
| `test/stdio.test.mjs` | 已测试正常启动和 EOF 释放；尚未测试启动被锁时 MCP 仍可诊断。 |
| `README.md` | 当前仅说明人工确认旧进程后移除空锁；缺少 MCP 诊断和恢复流程。 |

真实调用链：配置解析 → Projects/Engine 构造 → Projects.init → 工具注册 → serveStdio。故障发生在工具可达之前，单独增加普通工具而不调整启动路径无法解决问题。

## 假设与证据强度

1. **启动异常先于协议握手**：若成立，锁冲突时任何工具都不可达。源码顺序和两次真实连接已确认。
2. **客户端退出后留下遗留目录**：若成立，当前可无服务但目录仍在。当前快照与此相符；无旧 PID/启动时间，因此未确认历史原因。
3. **其他宿主仍持有该工作区**：若成立，清目录会制造多个写入者。常规进程筛查未发现对应启动项，但旧锁无归属信息，无法彻底排除；因此保留未知状态。

保存报告时临时客户端卡住的具体原因尚未复现。不能由此次启动故障反推卡住发生在报告写入、预览关闭或 client.close 的哪个阶段。

## 开源方案与社区证据

查询时点为 2026-10-21，Star 随时间变化；仓库状态不能替代本机验证。

| 项目 | 查询到的状态 / Star / 许可证 / 技术栈 | 可借鉴与缺口 |
| --- | --- | --- |
| [moxystudio/node-proper-lockfile](https://github.com/moxystudio/node-proper-lockfile) | 未归档，285 Star，MIT，JavaScript；GitHub API pushed_at 为 2023-10-25；README 完整 | mkdir 排他、mtime 心跳和受损处理可参考；按时间回收不等同于本项目要求的持有者死亡证明。 |
| [npm/lockfile](https://github.com/npm/lockfile) | 2021-08-11 归档，258 Star，ISC，JavaScript；有使用与选项文档 | 排他文件创建与重试可参考；已归档，不能补齐 MCP 启动诊断及身份核验。 |
| [bybraveHQ/proper-lockfile2](https://github.com/bybraveHQ/proper-lockfile2) | 自称维护中的分支，0 Star，MIT，JavaScript + TS 声明；有迁移、API 和回归说明 | 可参考并发回收测试；“通过 rename 修复”的主张需审查实现与本项目竞态后才能采用，不能直接视为证明。 |

原仓库 [issue #121](https://github.com/moxystudio/node-proper-lockfile/issues/121) 讨论了 rmdir 后 mkdir 的回收竞态：延迟的恢复者可能删除另一个进程刚建立的新锁。分支作者提供了修复主张与测试入口，仍需自行验证。此次不直接复制代码、不新增依赖；优先保留现有排他创建基础，并补齐本项目特有的协议可达性与所有权语义。

## 后续 MCP 路径与拒绝条件

以下为建议接口，尚未注册为工具：

1. `we_workspace_diagnose()`：仅诊断配置指定的工作区，不接受任意路径或任意 PID。返回锁是否存在、普通目录/链接状态、所有权信息、进程探测证据、稳定指纹、可恢复性与拒绝原因。旧空锁返回 owner unknown，不伪造 PID；无法读取或权限不足也返回 unknown。
2. 锁冲突时仍启动诊断会话；不授予项目写入或预览控制权限，不执行 unlock，不修改其他服务的注册表。环境探测是否在该模式开放需明确，不能让通用工具包装绕过所有权检查。
3. `we_workspace_recover(...)`：后续独立实现。调用方携带诊断所得指纹；执行前重新验证工作区、路径、锁身份与持有者状态。活跃、身份不明、元数据损坏、权限不足、指纹变化或回收竞争均拒绝。不得以锁年龄、空注册表、单次无 PID 或强制参数代替死亡证明。
4. 新锁需包含可核验的会话身份，至少涉及 PID、操作系统进程启动身份、主机和随机会话令牌；正常释放也需验证自己仍拥有该锁。具体格式和探测方法在实现前确定，不能只用 PID 防复用。创建目录后尚未写完元数据就崩溃的情况也必须保守处理。
5. 并发恢复必须有独立于普通工具队列的跨进程协调。普通锁获取者也须遵守同一协议；仅比较指纹、仅 rename 或仅在单个服务内 serialize 都不足以声称排除全部竞态。旧版本服务并存是迁移约束。
6. 恢复不等于工程回滚或预览接管。遗留 operation.json、checkpoint、预览窗口需单独验证。本次无身份记录的旧锁不能承诺自动恢复；若最终仍无法证明安全，需要明确的停机人工核验流程，不能静默删除。

## 四步交付

1. 本轮：核实与复现、保存诊断和设计边界，保留原锁。
2. 下一轮：补充锁身份记录、与之配套的所有权安全释放和诊断会话，提供真实 MCP 诊断回归；不回收其他会话的锁。
3. 再下一轮：实现身份核验与跨进程受控恢复，先验证竞争场景。
4. 最后：模拟崩溃、旧空锁、活跃持有者、PID 复用/权限失败、同时恢复与重启；验收工具并更新使用文档。

## 本轮审查

1. 为什么这样做：先证明故障所在与证据边界，避免把有效排他保护当作误报绕开。
2. 更简单的方案：直接删空目录更短，但无法满足未知持有者和并发写入约束；仅延长等待也不能修复握手前退出。
3. 架构与隐藏约束：本轮仅新增报告和被 Git 忽略的本机探针；后续必须保留单工作区单写者、工具队列、路径安全及预览所有权。
4. 临时绕路或技术债：没有产品绕路。临时探针只用于此次历史故障，不能算作正式 MCP 工具或完整恢复测试。
5. 规模扩大十倍的首要风险：多个客户端同时启动/恢复时的跨进程竞态，以及进程探测权限与旧版本并存；这是后续验收重点，而非增加重试次数即可解决。

未验证：原客户端卡住的根因、锁的历史持有者、任何自动恢复、跨进程恢复排他、异常遗留预览清理。现有测试通过不代表这些功能已验收。

## 第 2 步：MCP 可达诊断与新锁身份记录

以下为 2026-10-21 后续实现，以上第 1 步保留为历史证据。首轮临时故障探针预期旧行为，现在已由正式回归替代；不要再用它的退出码判断新版服务是否正确。

### 实现范围

- 新增 `src/workspace.ts`，沿用原子 mkdir 排他获取。新目录以排他文件创建写入版本化 owner.json，记录主机、平台、PID、随机会话标识、工作区、创建时间与进程启动身份。进程探测失败时记录 null，不伪造时间。
- `Projects.init()` 先获取锁，成功后才创建 projects 目录；冲突不会创建项目目录。直接项目访问入口也检查所有权，库调用不再可绕过 init。
- `src/index.ts` 只将 WORKSPACE_LOCKED 转为可握手的诊断会话。工具数从 13 增至 14，统一入口只豁免 `we_workspace_diagnose`，包括环境探测在内的其余工具都需要原锁指纹匹配。
- 诊断会话退出不释放锁、不操作预览。正常持有者释放前重核指纹，只删除自己已核验的 owner.json 并非递归移除空目录；失败保留现场，不吞掉错误。锁发生变化后拒绝后续工具和正常释放。
- 不自动升级诊断会话：即使原持有者正常退出，原诊断会话依旧没有写权限，需新启动会话重新获取。没有新增恢复工具或更改 CEF 配置。

### 诊断语义与限制

`we_workspace_diagnose({})` 返回配置工作区的 `mode`、锁状态、稳定指纹、经校验的 owner 及 holder 状态。Windows 的本机查询是固定脚本，通过系统 PowerShell 调用 [Process.GetProcessById](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.getprocessbyid) 和 [Process.StartTime](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.starttime)，比较原始 UTC ticks 字符串，避免 JS 整数精度丢失。只查询记录中的已验证数字 PID，不执行记录中的字符串，不读取进程命令行或终止进程。

只有 GetProcessById 明确报告不存在才返回 exited；权限/查询错误和超时均返回 unknown。运行进程启动时间不匹配时返回 pid-reused；这是身份不匹配诊断，不是回收授权。读取后与进程查询后复核锁指纹，变化则报告未知；这仍是采样证据，不是持续监测。

元数据读取最多 8 KiB，目录最多检查 8 个条目，拒绝非普通目录/文件、符号链接、目录联接和元数据额外硬链接；不读取任意工程内容。已有文件系统错误和记录损坏保守返回 unknown/unsafe。本轮所有报告的 `recovery.available` 都是 false。

这里的正常释放依赖参与者遵守当前获取/释放协议，**没有建立回收者与获取者之间的跨进程协调**，也不保证抵御外部程序在核验后主动替换目录的竞态。当前没有自动回收者；第 3 步引入恢复前必须补齐协调，不能把指纹核验当成原子比较并删除。非 Windows 的进程启动身份探测尚未实现。

### 验证记录

- 新增 `test/workspace-lock.test.mjs`：修改前真实握手以 Connection closed 失败；修改后旧空锁可握手、诊断持有者未知，逐一调用其余全部 13 个工具被拒绝，工作区未增加 projects 目录。
- 两个真实服务会话验证活跃持有者 PID/启动时间；诊断会话退出不改变 owner 记录，原持有者仍能创建工程。持有者退出后，诊断会话依旧不能写；新启动会话可获取新锁并读回工程。
- 元数据损坏、超过 8 KiB、异地主机、缺少启动身份、工作区不匹配、目录联接均不会变成“可恢复”。启动身份不匹配使用模拟记录验证，**未制造真实 OS PID 复用**。
- 对进程查询返回 EACCES 的检查在独立测试子进程中替换 Node execFile，实际运行诊断逻辑并确认 unknown；没有改产品代码注入测试分支，没有修改系统 ACL。曾尝试改变 SystemRoot 的测试会影响 Node 自身启动，已移除，不作为验收证据。
- 只强制结束测试自身创建的服务子进程，剩余会话可诊断 exited，但仍不回收锁。未取得锁的 Projects 写入、非持有者 unlock、元数据被修改后的原持有者操作/释放均被保护。
- 实际故障配置通过真实 SDK/MCP 连接验收：`.we-mcp/workspace-lock-diagnostic-verification.json` 中 error 为 null，返回诊断模式、owner null、holder unknown、恢复不可用；创建工程被拒绝。退出后旧锁的目录身份、时间、条目及工作区顶层条目、注册表和配置哈希均未改变。

最终检查：

| 命令 | 结果 |
| --- | --- |
| `npm.cmd test` | TypeScript 构建成功，19/19 通过；其中 5 项锁测试包含真实 MCP 会话与独立查询失败模拟。 |
| `node .we-mcp/verify-lock-diagnostic.mjs` | 实际旧锁可诊断且拒绝写入；锁、配置和注册表未改变。该脚本仅为本机验收，不随仓库分发。 |
| `node scripts/verify-engine.mjs` | Web 预览、虚拟鼠标、调参、多帧截图、源码保存、重载、发布准备和关闭通过，报告无 error。 |
| `node scripts/verify-scene.mjs` | Scene 编辑/回滚/重开、EOF 关闭两个活动预览、释放锁与重启通过；7 个检查点，error 为 null、cleanupErrors 为空。首次权限自动审核超时未启动，重试后执行通过。 |
| `node --check test/workspace-lock.test.mjs`、`git diff --check` | 通过。 |

验收后 Web 和 Scene 测试工作区的 active-previews 均为空、server.lock 均不存在；本次实际故障工作区的原空锁仍存在。

### 第 2 步审查

1. **为何选择该方案**：启动失败是工具不可达的直接原因，因此只把锁冲突降为诊断会话；统一入口保护所有普通工具，锁管理集中在一个模块，不改变引擎/工程格式。
2. **更简单的实现**：仅增加诊断工具无法越过握手前退出；仅捕获异常继续启动则可能获得无锁写权限。复用目录锁与系统只读 API，比增加心跳依赖、自动超时抢锁或常驻原生守护程序更符合本步范围。
3. **架构和隐藏约束**：保持单工作区单持有者、工具序列化、路径和预览身份边界。直接 Projects 调用现在也需成功 init，持久恢复测试已改为显式释放/重新获取，未绕过约束。诊断会话不接管旧预览。
4. **绕路/技术债**：无按 PID 白名单、按时间猜测失效、强制开关或产品测试分支。进程查询失败模拟只存在于测试子进程。正常释放尚不是跨进程原子回收协议，此限制已标注，必须由第 3 步处理。
5. **十倍规模首先受限之处**：单队列和每次调用的锁文件核验会增加 I/O，Windows 进程诊断每次需启动一个有期限的系统查询；多个恢复者的竞争仍未解决。本轮不增加缓存或抢锁以换取表面吞吐。

未完成/未验收：受控恢复工具、恢复与获取之间的跨进程协调、实际 OS PID 复用、真实 ACL 拒绝、恶意外部目录替换竞态、非 Windows 进程身份、原临时客户端卡住的根因，以及原空锁的历史持有者。回滚时应先正常结束本版持有者并确认其锁已释放，再撤销本次提交并构建；本轮代码基线为 `1358267`。

## 第 3 步：跨进程协调与显式恢复

2026-10-22，实现基线 `34d9746`。前两节是历史记录；“恢复未实现/available 固定 false”等描述不再代表本节版本。当前总计 15 个 MCP 工具。

### 方案与来源

沿用第 1 步的三个开源锁库比较，本步没有新增依赖或移植第三方代码。单独的目录 guard 也会遗留；按时间抢锁或仅 rename 不能满足本项目的身份和竞争约束。这里使用 Node 标准库的 Windows 命名管道作为短临界区，原目录锁继续表示工作区持有权。

[Node 24.15 IPC 文档](https://github.com/nodejs/node/blob/v24.15.0/doc/api/net.md#ipc-support) 说明 Windows 管道随持有进程退出移除；[同版本 libuv 源码](https://github.com/nodejs/node/blob/v24.15.0/deps/uv/src/win/pipe.c) 的首次实例排他创建，是本机单例验证的依据。实现按工作区目录 dev/ino/birthtime 的哈希选管道名，显式 exclusive 监听，不依赖路径大小写区分，不接受管道中的应用命令；连接立即断开。获取、正常释放和恢复都经同一入口，竞争最多等待约 1 秒后报告忙，计时使用单调时钟。

[Node issue #65057](https://github.com/nodejs/node/issues/65057) 报告了非默认 NODE_PENDING_PIPE_INSTANCES 与失败绑定时的原生崩溃。当前未配置该变量的 Node 24.15.0/libuv 1.51.0 已通过测试；配置了它时保守拒绝协调，并通过 MCP startupIssue 展示原因，不修改运行环境。卷类型通过系统 [DriveInfo](https://learn.microsoft.com/en-us/dotnet/api/system.io.driveinfo.driveformat) 只读查询，无需新的 helper。

### 文件与接口

| 文件 | 本轮改动 |
| --- | --- |
| `src/workspace.ts` | 共用 OS 互斥；Windows 新锁记录 version:2 与 windows-pipe-v1；读取/归档边界；恢复资格核验和审计记录。version:1 保持可诊断，不升级、不回收。 |
| `src/projects.ts` | 恢复取得锁后初始化项目目录，失败明确报告已取得锁但工程目录未就绪。 |
| `src/index.ts` | 注册 we_workspace_recover；标注会改变锁状态；诊断/恢复以外仍要求持有锁。startupIssue 保留获取失败原因。 |
| `test/workspace-lock.test.mjs` | 扩充真实双会话恢复、互斥竞争、归档失败、旧协议拒绝和配置不可用等检查。 |
| `test/stdio.test.mjs` | 正常协议工具数更新为 15。 |
| `README.md` 与本报告 | 使用步骤、错误语义、适用条件与验收边界。 |

恢复调用必须携带最新 expectedFingerprint 和 confirm:true；不接受任意路径、PID 或强制开关。只有本机固定 NTFS 上、采用新协调协议的锁，且原持有者明确退出时才成为候选。活跃、PID 启动身份不匹配、未知、旧版记录、缺少身份、网络/其他文件系统或查询失败均拒绝。available:true 只是采样时的候选状态，执行时在互斥内重核，不能当作授权或预留。

成功流程：写 prepared 审计 → 有界复制旧 active-previews（最多 1 MiB）→ 再核指纹 → 归档旧锁目录并验证 → 写 archived 审计 → 排他取得新锁 → 写 acquired 审计。归档位于工作区 lock-recoveries/UUID，不删除历史证据，不改工程内容、不回滚 checkpoint、不接管窗口，也不覆盖当前注册表。恢复后同一 MCP 会话取得普通工具权限。

错误包括 WORKSPACE_LOCK_CHANGED（指纹过期）、WORKSPACE_RECOVERY_REFUSED（资格不满足）、WORKSPACE_COORDINATION_BUSY/UNAVAILABLE（协调受阻）及 WORKSPACE_RECOVERY_INCOMPLETE（中途停止）。最后一种会返回阶段和当前是否持有锁；可能已经取得新锁，需先诊断，不能盲目重试。不会为了恢复错误自动回滚、覆盖现有目录或删除证据。

### 验证

- 修改前新增的真实 MCP 恢复检查因 Tool we_workspace_recover not found 失败；实现后通过。
- 独立进程验证同名管道只能有一个持有者，终止本次测试子进程后可重新取得管道。生产临界区测试还验证获取、释放和恢复全部受该互斥保护；没有终止用户进程来制造条件。
- 两个真实 MCP 客户端同时对同一旧指纹恢复，恰好一个成功，另一个报告指纹变化或互斥忙；归档仅一份，失败方退出不释放胜者锁。
- 明确确认、指纹匹配、拒绝活跃者/旧空锁/v1、归档设置失败保留旧锁、查询失败保守判定和非默认管道设置下可达诊断均有回归。测试的 PID 启动身份不匹配与 EACCES 仍为模拟，不称为实际 OS PID 复用或 ACL 验收。
- `npm.cmd run build` 成功。最终 `node --test` 对 test/*.test.mjs 输出 25/25 通过、无跳过；双 reporter 参数另外保存 `.we-mcp/workspace-recovery-tests.xml`，不提交运行产物。
- 原用户故障工作区通过真实 MCP 尝试恢复，返回 OWNER_UNKNOWN/WORKSPACE_RECOVERY_REFUSED。锁指纹仍为 ee2de4502f41159842e4fc836ed7f2d51b16ed66cf093dc0268120fcc1a9550c；锁、顶层条目、注册表和配置哈希未改变。报告 `.we-mcp/workspace-lock-recovery-guard-verification.json`。

本机最终构建/测试命令（reporter 的输出目录 .we-mcp 已存在）：

```powershell
npm.cmd run build
node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=.we-mcp/workspace-recovery-tests.xml test/*.test.mjs
```

### 实机回归中的失败与恢复

首次 `node scripts/verify-scene.mjs` 未出现测试预览，留下未绑定身份的注册表条目，客户端结束后留下 PID 8312 的新版锁。单独直接调用官方 CLI 也复现 WINDOW_NOT_FOUND，证明该现象不要求经过 MCP 锁路径。此处没有确认引擎内部根因；失败客户端的关闭期限与服务关闭探测期限不一致也需后续独立验收，不能反推原用户卡住的历史原因。

使用新 MCP 接口确认测试锁的 PID 8312 已退出后，显式恢复成功，诊断模式转为 owner，退出后新锁正常释放。旧锁、注册表及失败报告保存在 `.we-mcp/scene-verification/data/lock-recoveries/c9083c3e-a750-4fe5-9520-432a39b52a6c/`，原始注册表 SHA-256 为 7e662942c1e45f379aa19e364e754f459133be9b6e194e468837179cabb33f6a。恢复没有接管旧预览；辅助程序只确认其唯一名称已不存在。报告 `.we-mcp/scene-test-lock-recovery-report.json`，error 为 null。

沿用用户已有重启授权停止配置引擎后，引擎被自动拉起，启动脚本因此报 already running；没有再次终止或修改 CEF 配置。新的直接 CLI 检查成功，随后完整 Scene 回归通过：7 个检查点、error:null、cleanupErrors:[]，覆盖编辑/回滚/重开、两个活动预览随 EOF 关闭、锁释放和服务重启。没有修改预览实现或放宽窗口身份检查。最终测试工作区注册表为空且无锁；原用户空锁仍保留。

### 第 3 步审查与剩余边界

1. **为何选择**：把所有锁状态迁移放进同一 OS 临界区，防止恢复者删除新持有者的锁；归档保留原始证据。标准库即可实现，无新守护进程或依赖。
2. **更简单的方案**：仅目录 guard 会重现遗留 guard 问题；仅 rename/指纹不能排除多进程窗口；超时抢锁不能证明持有者已退出，因此不采用。
3. **架构约束**：继续单工作区单写者、串行工具、路径安全和会话预览归属。旧协议只读兼容，不能静默宣称其参与新协调；新恢复不接管任何旧窗口。
4. **绕路/技术债**：没有按固定 PID 放行、跳过验证、强制删锁或改测试预期掩盖失败。模拟与临时诊断脚本仅用于验证。恢复是受协调的多步操作，不是完整持久事务：创建目录后、身份写完前崩溃仍可能留下 unknown 空锁；磁盘断电持久性和逐指令崩溃未验收。
5. **十倍规模首要限制**：同工作区状态迁移串行且系统查询占用临界区，竞争会忙，没有公平性或吞吐保证。网络文件系统、跨机器与外部强行替换目录不在本协议保证内，不以缓存或更激进回收扩展范围。

未完成：第 4 步完整异常场景验收、恢复各阶段崩溃、真实 ACL/PID 复用、原旧空锁的安全人工处理流程，以及失败预览下客户端/服务退出期限的专项验收。原保存报告卡住的历史根因仍未确认。本轮只交付第 3 步；回滚基线 `34d9746`，先正常结束本版持有会话，确认锁已释放，再撤销提交并构建，避免带活动 v2 锁直接降级。

## 原旧空锁的实机恢复

2026-10-22，基线 `c22e3dc`。本次独立任务恢复原配置工作区；没有修改产品源码、公共 MCP 恢复策略、引擎配置或工程内容。此前未检查系统启动时间，遗漏了可用于此次人工判断的证据。

### 新证据与处理范围

所有下列时间均为 Asia/Shanghai：

- 原锁创建及修改：2026-10-21 19:08:59.524；普通空目录，没有 owner.json。
- 原只读诊断完成：2026-10-21 19:19:38.864，记录工作区路径、目录 dev/ino/birthtime/mtime、空条目及前后身份一致。
- Windows 最近启动：2026-10-22 07:47:38.500，由本机 Win32_OperatingSystem 查询；恢复时系统时钟晚于该时间。
- 恢复前当前目录与上述历史记录逐项相同，锁指纹仍为 `ee2de4502f41159842e4fc836ed7f2d51b16ed66cf093dc0268120fcc1a9550c`。卷查询为本机 Fixed / NTFS。

[Win32_OperatingSystem 文档](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-operatingsystem) 将 LastBootUpTime 定义为操作系统最近重启时间。这里使用的是重启前已观察到的同一个锁目录和重启事实，足以排除原进程仍存活于本次系统启动；遵守目录锁协议的新进程也不能取得这个已存在的空锁。单凭目录年龄、没有发现进程或注册表为空，仍不足以回收锁。

这是一项针对本次留有历史证据的本机事件的人工处置，不是对任意未知锁的自动恢复规则。公共 `we_workspace_recover` 仍拒绝缺少身份的旧锁，不增加 force 开关或按锁龄放行。

### 执行与保留证据

通过本机一次性脚本，在现有 WorkspaceLock 的 Windows 命名管道临界区内重新查询启动时间、核验锁身份、空目录、工作区持久数据哈希和原始诊断。脚本先写 prepared 审计并备份原配置与空预览注册表，再将精确匹配的旧锁 rename 到以下归档；没有删除锁或终止用户进程。

```text
.we-mcp/creations/jianyue/data/lock-recoveries/01962e4e-ddfc-4303-9ede-68455edeb184/
  server.lock/             # 原空目录，目录身份和时间保持一致
  operator-record.json     # 当前 state: verified，含恢复依据与验收结果
  config-original.json
  active-previews.json
```

归档后使用未修改的 `.we-mcp/creations/jianyue/config.json` 启动真实 SDK STDIO/MCP 客户端，由产品正常获取新锁。初次验收脚本把列表总数误写成 4，实际为 4 个托管工程加 1 个外部源工程，因此提前停止；其客户端正常退出且释放了新锁。该断言错误保留在报告的 initialVerificationError 字段，修正后的单独验收脚本只进行验证，不再执行旧锁归档。

### 验收结果

| 检查 | 结果 |
| --- | --- |
| 原配置连接、we_workspace_diagnose | 两个后续独立会话均 mode: owner、holder: alive、startupIssue: null。 |
| we_project_list / we_project_inspect | 全部 5 个条目可读取；4 个原托管工程及 1 个只读源工程；列表无 warnings，各项 revision 与磁盘一致，静态验证通过。 |
| we_project_apply | 对托管工程提交内容完全相同的 project.json，expectedRevision 校验通过；changed: []、checkpointId: null。只验证编辑入口与无变更路径，不声称完成了新的实际文件写入。 |
| 正常退出、再次连接、再次退出 | 两次完整会话均正常结束，每次退出后 server.lock 均不存在；第二次列出的工程与第一次完全一致。 |
| 持久数据完整性 | projects 29 文件、checkpoints 60 文件、origins 4 文件：恢复前后各目录内容 revision、字节数和文件数相同。全部 7 份 operation.json 均 complete。 |
| 配置、注册表、原锁证据 | 配置与 active-previews.json 字节不变，注册表仍为 []；归档旧锁与历史目录身份、时间、条目逐项一致。 |

本机运行命令及产物（均为忽略的运行文件，不随仓库分发）：

```powershell
node --check .we-mcp/recover-legacy-after-reboot.mjs
node .we-mcp/recover-legacy-after-reboot.mjs
node .we-mcp/verify-restored-legacy.mjs
git diff --check
```

首个恢复命令的归档成功、初次验收因上述计数断言退出码为 1；后续独立验收退出码为 0，`.we-mcp/legacy-workspace-restored.json` 的 error 为 null、sourceCheckpointsOriginsAndConfigUnchanged 为 true。最终恢复与验收完成于 2026-10-22 13:05:08 左右。源码和测试文件未变，本次没有重复运行上轮已通过的 25 项产品测试；实际原配置的两次 MCP 会话是本次主要验收。

### 审查、回退与后续

1. **为何选择**：新增重启证据使原持有进程不可能继续存活，结合重启前后的同一目录身份，可原地归档这次旧锁，避免迁移或更换配置。
2. **更简单的实现**：直接删除会丢失证据；复制整个工作区增加路径变更和数据遗漏风险。一次归档并使用正常启动路径足够，不需要新增产品接口。
3. **架构约束**：沿用现有跨进程协调，归档后由正常 MCP 会话取得锁；公共未知锁拒绝策略、预览归属与单写者规则保持原样。一次性脚本调用编译后内部协调方法，未将该操作暴露为公共能力。
4. **绕路与技术债**：精确路径和历史指纹仅存在于忽略的一次性事件脚本，不进入产品代码。验收计数错误已明确保留；未为通过检查更改产品或历史数据。这种人工恢复依赖可靠的本机历史记录，不能当作通用自动回收方案。
5. **十倍规模首要限制**：逐事件核对系统重启、历史目录身份和归档不适合大量无人值守恢复；应另行设计可验证的持久恢复协议，不能降低未知锁保护来扩展吞吐。

报告回退基线为 `c22e3dc`，本次提交只更改本文。运行现场的旧锁保留在上述归档，不应为回退文档而恢复阻塞；若确需还原事故现场，必须先结束所有相关会话，确认没有当前持有者或新锁，再单独审核目录身份和归档审计，不可覆盖当前 server.lock。

原工作区阻塞已解除。未验证或未完成的部分：失败预览下客户端与服务的退出期限、原保存报告卡住的历史根因、恢复各阶段崩溃、真实 ACL/PID 复用，以及恶意外部目录替换。下一独立任务是构造失败预览退出的回归，定位并修复能否正常释放锁；本次不混入该代码改动。
