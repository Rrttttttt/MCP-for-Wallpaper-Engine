# 能力审计问题跟进

2026-10-23。输入为本机 `.we-mcp/creations/jianyue/data/projects/capability-audit-web-starfield-1792666436520/CAPABILITY-AUDIT.md`。原文保留为历史黑盒记录，不改写其原始结论；本文追踪后续状态。用户要求优先处理审计问题，超分研究及图片入口进度保留，暂不继续超分开发。

## 当前状态与四步安排

| 审计问题 | 当前状态 | 对应步骤 |
| --- | --- | --- |
| P1：owned CEF 目标缺失、日志/鼠标/重载链路不可靠 | `adf3861` 已修复双回环发现并完成当时的真实引擎验收，见[验收记录](cef-loopback-acceptance.md)。本轮预览复验失败，不能认定当前环境的运行闭环已重新验收。 | 第 1 步已有成果 |
| P2：`function (` 仍通过静态校验 | 本轮补 Web JavaScript 解析、模式区分、位置报告、解析进程期限，以及 apply/validate/preview/publish 拒绝回归。 | 第 1 步本轮交付 |
| P1/P2：二进制素材入口 | `d8d32cb` 提供 PNG/JPEG/WebP；第 2 步现已加入 WAV/MP3/MP4/WebM 元数据探测与原字节导入，详见[媒体入口](media-import.md)。这是限定格式的首版入口，不能代表完整解码、全部媒体格式或引擎播放通过。 | 第 2 步完成首版入口 |
| P2/P3：视频完整创建、音频真实回调 | 缺视频工程创建/播放验收，以及有声、静音、关闭响应的受控真实音频验收。 | 第 3 步待实施 |
| P2：Scene 多层与纹理编译 | 仍为 scene-orbit 起点；拟完成用户图片 → 受管素材 → 纹理编译 → 两层 Scene → 属性绑定 → 真实截图。 | 第 4 步待实施 |

4K/HDR、多屏、长期性能、点击/滚轮/键盘、复杂骨骼/粒子/蒙版及自动工坊上传仍无验收；不因表中四步自动宣称覆盖。超分进度对应 `f1cbf9f` 的[研究](image-upscaling-research.md)和 `d8d32cb` 的[图片入口](image-import.md)，没有删除、回滚或继续接入模型。

## 第 1 步：复现与根因

先新增 `test/javascript.test.mjs` 并运行：

```powershell
npm.cmd run build
node --test test/javascript.test.mjs
```

修复前 2/2 失败：共享 validate 对 `wallpaper.js = "function ("` 返回 valid=true；Projects.apply 没有抛出预期的 VALIDATION_FAILED。重新构建仍复现，排除了 dist 过旧；直接调用共享 validate 也复现，排除了仅 MCP 路由绕过检查。根因是原校验器只检查 JSON、引用与部分文本规则，没有 JavaScript 解析。

共享调用关系：`src/projects.ts validate` 被 inspect、create、replace/apply/restore、publish 和 `src/engine.ts open` 使用。因此修复放在共享入口，不逐个工具添加不同规则；无效修改在保存检查点和工程写入之前被拒绝。

## 开源比较及复用

开发前搜索 GitHub、上游文档及 issue 社区。Star 是本次网页近似快照，不能证明质量。维护版本以 npm registry 查询和本地安装包为准，避免把缓存的 master package.json 当作最新发行。

| 项目 | Star / 许可证 | 技术栈、维护证据和用途 |
| --- | --- | --- |
| [Acorn](https://github.com/acornjs/acorn) | 约 11.5k；[MIT](https://github.com/acornjs/acorn/blob/master/acorn/LICENSE) | JavaScript，附类型声明；固定安装 8.19.0，本地 CHANGELOG 与 registry 记录 2026-10-05。普通脚本与模块模式 API 完整，适合仅解析语法。 |
| [Meriyah](https://github.com/meriyah/meriyah) | 约 1.2k；ISC | TypeScript；registry 查询 7.4.0，修改时间 2026-10-05；[发行记录](https://github.com/meriyah/meriyah/releases)与文档可用。也是可行解析器，本轮无需再引入第二套 JS 解析器。 |
| [parse5](https://github.com/inikulin/parse5) | 约 3.9k；MIT | TypeScript，HTML5 解析器；固定 8.0.1，registry 修改时间 2026-04-19。识别真实 script 节点及属性，避免用正则误判注释、模板或引号中的 `>`。 |

直接复用 Acorn / parse5，不复制修改它们的源码，不移植完整 lint、构建或浏览器框架。新增的项目适配仅负责输入预算、解析隔离、HTML 加载模式选择和验证结果合并。

上游 [Acorn #1445](https://github.com/acornjs/acorn/issues/1445)报告某类重复命名捕获组正则存在二次方解析耗时；该记录并非针对本服务的已发生事故，也不在本轮假定上游已修复。由此给整个解析子进程设置期限，回归测试使用缩减后的病态输入验证实际终止，避免只用普通小脚本证明不会卡住。

## 文件与行为

- `src/javascript.ts`：保留同步 validate API，以 Node 标准库 spawnSync 启动固定解析程序；不启用 shell，不把用户代码拼进命令。只传 HTML/JS/MJS 输入，不复制图片、模型或整个工程到子进程。清除解析子进程的 NODE_OPTIONS/NODE_PATH，避免继承预加载脚本。
- `src/javascript-parser.ts`：复用 HTML 与 JS 解析器；只读取 stdin 中的源码并返回 JSON，不调用 eval、Function、vm 执行或浏览器。不请求网络，不自行读取工程或修改工程。
- `src/projects.ts`：仅 Web 工程进入新检查，合并错误到原 errors，并增加 javascript 报告。SceneScript、GLSL 和其他类型继续保留各自的运行/编辑器验收要求。
- `src/index.ts`、`README.md`：更新现有 validate 工具说明；工具数量仍为 17，没有增加任意执行工具。
- `package.json`、`package-lock.json`：固定 acorn 8.19.0 与 parse5 8.0.1（后者带 entities 依赖）。
- `test/javascript.test.mjs`、`test/stdio.test.mjs`：错误复现、模式/边界/超时测试、真实 MCP 诊断与拒绝验证；本文记录状态、证据和剩余任务。

## 解析规则与实际边界

1. HTML 中明确普通脚本使用 script 模式，`type=module` 使用 module 模式，二者不能互相兜底。外部脚本以同一文件在不同模式加载时，分别检查；只支持本地 .js/.mjs 引用。内联错误返回原 HTML 的一基行列号。
2. 没有被 HTML 直接引用的 .mjs 以模块解析；没有明确加载模式的 .js 可用 script 或 module 任一语法解析，报告标记 script-or-module，不把此结果当作浏览器加载方式的证明。没有做模块依赖图或 import 路径解析。
3. JSON、GLSL 等非 JS script 数据块和惰性 template 内容不作为可执行 Web JS 解析。检查所有本地 .js/.mjs，包含暂时未使用的文件；未编译 JSX/TypeScript、.cjs、HTML 事件属性、动态生成代码、SVG 脚本、base URL、非 UTF-8 源码仍需独立处理。HTML 解析不等于 HTML 有效性或加载路径完整校验。
4. 单个 HTML/JS 输入最多 1 MiB，序列化前输入总量最多 8 MiB，worker 对 HTML 与脚本实际解析工作再累计 8 MiB，最多 256 次脚本检查。内联脚本会包含在 HTML 字节及实际脚本工作量中，故可能早于物理文件合计 8 MiB 达到预算。
5. 最多返回 64 条语法问题及 32 条额外警告，首次语法错误即足以使 valid=false；不是穷尽错误列表。源码/次数预算不足返回 JS_CHECK_LIMIT，解析超时返回 JS_CHECK_TIMEOUT，异常退出、内存或输出上限等返回 JS_CHECK_FAILED；均不记录语法通过。
6. 子进程期限 3 秒，stdout/stderr 各受 maxBuffer 128 KiB 限制，V8 old-space 配置为 256 MiB。后者不是 OS 总 RSS 上限，期限也不包括父进程读文件、原有静态规则和序列化成本。解析过程会短时阻塞当前同步校验调用；不引入长期 worker 或任务系统。
7. `javascript.status:passed` 只代表所列输入在解析器支持语法中通过；`javascript.runtime` 和 `engineVerification` 仍为 unverified。CEF 版本、宿主 API、着色器、跨脚本全局冲突、资源加载与视觉效果都需要真实运行验证。

行为变化：已有损坏脚本仍可 inspect/validate 并获取错误；create、apply、preview、publish 及 restore 的候选内容会受同一新校验约束。过去保存的含语法错误检查点也可能无法直接恢复，需要先检查并修复源码。既有预览快照不会因源码校验而自动更新。

## 验证与验收

```powershell
npm.cmd test
node --test test/javascript.test.mjs test/stdio.test.mjs
git diff --check
```

Windows / Node 24.15.0 下，完整构建及测试 53/53 通过、0 跳过，约 93.7 秒。随后扩充真实 STDIO 的旧损坏工程案例，该测试单独复跑通过：validate 报 JS_SYNTAX，preview 与 publish 在进入引擎/导出之前返回 VALIDATION_FAILED；通过 MCP apply 修复后 revision 精确回到原值。

专项验证包括审计原始 function (、普通脚本与模块区别、严格模式/顶层 await、同文件两种模式、内联语法与行列号、数据块和惰性模板、非执行性、路径拒绝、外部脚本未检查警告、单文件/总字节/次数预算、诊断条数上限、SceneScript/GLSL 边界。Acorn 病态输入在约 3 秒后返回 JS_CHECK_TIMEOUT，随后正常检查成功。

另用真实 STDIO 对审计星空和已验收人像原工程作只读 validate，并各创建独立副本；分别检查 1 个与 3 个脚本，全部通过。前后原工程 revision 一致，客户端关闭后锁释放。原始回执位于本机忽略目录 `.we-mcp/javascript-acceptance/8da4ddfd-0d23-4981-b2cb-8c6dfd909542/report.json`；原 revision 分别为 `0827accf778ff524aeb899ffc6d7d7aaa89d21a8564597c2f7575a0cf1e12d9d` 和 `b92d8d1040f838af4ae6fe9d173f3f4cc39f8a96504d3b5592d2beafa9f44027`。

本轮真实引擎复验未通过，必须保留失败：受限运行先报 WINDOW_ENUMERATION_FAILED；正常桌面权限重试后报 WINDOW_NOT_FOUND，未出现自有预览窗口，CEF 端点也不可用。第二次报告 `.we-mcp/cef-verification/1f589534-29d3-4885-89a6-52850cca1f00/report.json` 记录 window-absent、cleanupErrors=[]、源 revision 未变。此项不是本轮语法修复已造成引擎回归的证据，也不能据此认定引擎链路正常。尚未重验真实渲染、鼠标、属性读回、重载、眼部/头发观感；原文的媒体/Scene/性能缺口保持未完成。

## 五项审查与回滚

1. **为何此方案**：修复共享 validate 根因，覆盖所有现有调用；复用成熟语法解析器，区分浏览器加载模式，并对已知高耗时解析路径加进程期限。
2. **更简单的实现**：Node vm.Script 可处理部分普通脚本，但不足以统一覆盖 Web 模块和 HTML 内联；在主进程直接 Acorn 解析更短，却缺乏可终止的 CPU 边界。没有引入完整 ESLint 或 Web 构建系统。
3. **架构/隐藏约束**：保持同步 validate 与既有 revision、检查点、锁流程，新增不写文件的短生命周期子进程。新预算会拒绝过大项目，语法有误的历史检查点也会被拒绝；这两个兼容性影响已明确列出。原生 Scene 不进入 Web 解析器。
4. **绕路/技术债**：没有执行用户脚本、猜测所有 .js 都是模块或用容错解析器把错误当通过。script-or-module 是未构建模块图的明确范围；进程启动开销和 old-space 非 RSS 总上限仍是边界。测试没有依赖特定作品坐标或修改已验收作品。
5. **十倍规模先受限哪里**：重复验证会反复启动进程、序列化和解析相同输入，先影响延迟。当前不预建缓存/worker 池；有实测批量需求时，再考虑按内容哈希复用结果并保留同等隔离与期限。

本轮回滚基线 `d8d32cb`，撤销本次独立提交即可移除新增语法检查；不回滚图片导入、超分研究、工作区工程或当前桌面壁纸。原始审计和成功人像工程均保留不动。下一独立任务为音频/视频素材入口，在用户确认后继续。

## 第 2 步跟进：音视频素材入口

用户确认后实施本步，代码回滚基线为 `b317d46`。新增 `we_media_inspect` / `we_media_import`，工具总数为 19；复用图片入口的目录与写入保护、revision 及持久检查点。MediaInfo WASM 在有期限的独立子进程中探测，只返回精简元数据、哈希和未验证边界，不把成功探测冒充成功播放。MCP 请求取消和服务 EOF 均可停止尚未进入保存阶段的媒体探测。

自生成 WAV/MP3/MP4/WebM，以及本机安装目录内的 WAV/WebM 均通过真实 STDIO inspect → import → 字节哈希核对 → restore；源文件未变，锁正常释放。完整文件、验证、许可证及五项审查见[媒体入口报告](media-import.md)。第 1 步记录的引擎预览复验失败在本步没有被覆盖为通过；第 3 步的视频创建/播放和真实系统音频链路仍待完成，Scene 多层仍为第 4 步。超分研究及进度继续保留。
