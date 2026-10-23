# 用户图片到两层 Scene 的验收

2026-10-23，审计整改第 4 步。用户指定 `D:/CodeX Workstation/Image Workstation/DLL/躺椅2.png`，并确认采用“原图背景＋小光点叠加层”。没有拆人物、补背景、增加眼睛/头发动画，也没有继续超分。原图及生成工程只保存在本机，不进入 Git。

## 实现前比较

| 项目 | Star / 许可 | 技术与维护依据 | 决定 |
| --- | --- | --- | --- |
| [RePKG](https://github.com/notscuffed/repkg) | 约 3.8k / MIT | C#，PKG 解包、TEX 转图片，README 有命令及格式说明；[提交记录](https://github.com/notscuffed/repkg/commits/master/)公开，不据 Star 宣称持续活跃。 | 方向主要是读取/转换，不能直接替代官方 PNG→TEX 编译；不引入解包依赖。 |
| [linux-wallpaperengine](https://github.com/Almamu/linux-wallpaperengine) | 约 4.7k / GPL-3.0 | C++/OpenGL/CEF，格式文档及构建说明完善，[历史](https://github.com/Almamu/linux-wallpaperengine/commits/main/)可见 2026 年维护。 | 参考模型→材质→纹理关系；不移植完整播放器或其 GPL 源码。 |
| 已安装的官方引擎 | 专有程序，用户本机已有 | 开发者社区给出 [resourcecompiler -tex -i -o 命令](https://steamcommunity.com/app/431960/discussions/2/340412122401455740/)，本仓库构建模板脚本已使用同一路径。 | 复用用户安装的 resourcecompiler64.exe 及已有模板；固定参数，临时副本编译，不分发二进制。 |

官方文档：[图片层的纹理属性](https://docs.wallpaperengine.io/en/scene/userproperties/texture.html)、[IEngine.userProperties / frametime](https://docs.wallpaperengine.io/en/scene/scenescript/reference/class/IEngine.html)、[动态改变图片 Scale 的示例](https://docs.wallpaperengine.io/en/scene/scenescript/tutorial/audio.html)。本轮选择现有模块与官方编译器，未从零编写 TEX 编码器、Scene 播放器或分割模型。

## 模块、依赖与改动文件

调用链：`we_scene_create` → assetRoots 有界读取/哈希 → 共享图片解码 → 方向/sRGB PNG → 复用 scene-orbit 构造两层 → 独立临时目录 → 固定官方编译器子进程 → 有界纹理读取/头检查 → 共享 validate → 清理临时目录 → createFiles 独占新建。后续编辑继续使用 apply/restore 的 revision 与检查点；预览沿用既有原生窗口身份校验。

| 文件 | 修改原因 |
| --- | --- |
| `src/scene.ts` | 图片背景＋几何生成的透明暖色光点、固定编译、预算和取消/清理；复用已有 Scene 模板与保存逻辑。 |
| `src/images.ts` | 仅导出并命名已有 imageMetadata，供 Scene 共用完整解码；原图片 inspect/import 的限制不变。 |
| `src/projects.ts` | origin 记录允许 imageSourceHash，其他新建、检查点、恢复语义不变。 |
| `src/index.ts` | 注册 we_scene_create，使用既有请求信号/退出信号与队列；共有 21 个工具。 |
| `src/engine.ts` | 环境能力报告列出新入口，同时保留 limited 状态与运行时验证要求。 |
| `test/image-scene.test.mjs`、`test/fixtures/scene-compiler.mjs` | 普通测试使用测试专用编译进程，检查实际子进程期限/退出与保存边界，不依赖本机引擎或用户图片。 |
| `test/stdio.test.mjs`、`test/workspace-lock.test.mjs` | 更新 21 工具握手，以及诊断模式对新工具的写入拒绝。 |
| `scripts/verify-image-scene.mjs` | 用户选图的真实 MCP/官方编译/窗口/像素/调参/回滚/重开/发布暂存验收；不进入普通测试。 |
| `README.md`、`docs/capability-audit-followup.md`、本文 | 接口、证据、审查及剩余范围。 |

没有新增 npm 依赖、模板目录、编译器分发包或公共任意命令/eval 工具。

## 使用及范围

先配置明确素材目录为 assetRoots，再 inspect 获取 SHA256：

```json
{"name":"we_scene_create","arguments":{"name":"image-light","title":"My image scene","sourceRoot":0,"sourcePath":"picture.png","expectedSourceHash":"<we_image_inspect 返回的 SHA256>","properties":{"speed":0.08,"lightVisible":true}}}
```

生成 type:scene，画布为图片的显示尺寸。背景为固定图片层；第二层是独立 RGBA 径向光点，起点与位移按画布比例计算，不包含针对这张人物图的分割坐标。参数：speed（0～2）、amplitude（0～画布宽度 20%）、lightSize（4～较短边 15%，极小图至少 4）、lightVisible。大小使用固定 64×64 精灵的 Scale 绑定，位置复用原模板按 frametime 积分的 SceneScript。显示开关也从 engine.userProperties 读取。

原始 PNG/JPEG/WebP 字节写入 `sources/original.*`；编译副本执行 EXIF 方向归一化及 sRGB 转换，不改原图、不做超分、不缩小显示尺寸。纹理配置固定 rgba8888、nonpoweroftwo、nomip、clampuvs。源图最多 20 MiB，现有解码单边上限 8192；本入口另限 8388608 像素并按原图＋PNG＋RGBA 纹理预估 64 MiB 工程预算，最终仍经 64 MiB / 2000 文件校验。该配置避免 DXT 有损压缩，但不能恢复原图没有的细节。

编译器仅取配置安装目录的 `bin/resourcecompiler64.exe`，不跟随链接、不接受用户 flags 或自选可执行文件名。每个子进程 timeout 30 秒、stdout/stderr 合计最多 64 KiB；逐个处理背景及光点。输出纹理经普通文件/非硬链接、有界读取（33 MiB）与 TEXV0005 头检查，并不是完整 TEX 解码器。实际图像有效性继续依赖官方引擎。两次编译的总时间可超过 30 秒，客户端宜允许 90 秒请求期限。

编译失败、损坏/超大输出、编译中取消或 EOF 不保存新工程；只清理本次 mkdtemp 子目录。先清理再最终保存，避免临时清理失败被误报成“没有创建工程”。普通新建仍非跨文件事务：一旦进入 createFiles，磁盘故障可能留下不完整新目录；不自动删除现场或覆盖重试。强制杀进程可能留下工作区锁/构建目录，需要核实持有者后走既有诊断恢复，不保证自动回收。

Sharp 解码及 PNG 转换仍在服务进程中，沿用已有解码限制并有 10 秒处理期限；本轮取消/EOF 测试覆盖的是**正在运行的编译器子进程**，不能外推为任意图片处理阶段都能在 SDK 关闭宽限内退出。编译器原生内存没有操作系统级 RSS 限额；像素/输入/输出/期限是有界预算，不是进程沙箱。SceneScript 的静态语法/运行日志仍不全面可见。

## 验收与原始证据

输入：1536×1024，1965157 字节，无透明通道；原图 SHA256 `c15ac77797a9f1c3fd0bc847d8ace9e4c01f8c6c58a3fba946c303675163553e`。结束时源哈希相同。官方引擎 2.8.42；本机编译器 SHA256 快照 `09957ab6cfdf206a0825ffc8c3306e2e11473b1d6136523fa689a707766ee00d`，不把此哈希当成其他机器的准入名单。

```powershell
npm.cmd test
node --check scripts/verify-image-scene.mjs
node scripts/verify-image-scene.mjs 'D:\CodeX Workstation\Image Workstation\DLL\躺椅2.png'
git diff --check
```

最终 `npm.cmd test` 构建成功，71/71 通过，0 失败、0 跳过，87.3 秒；脚本语法检查及 git diff --check 通过。9 项新测试覆盖 JPEG 方向归一化、原字节、独立图层/绑定、真实 STDIO 新建与回滚/暂存，以及编译退出失败、日志超限、坏纹理、超大纹理、实际 30 秒超时、MCP 取消和 EOF。编译进程测试使用 preload 替代该固定执行边界，不能冒充官方编译结果；真实验收脚本单独调用用户安装的官方程序。

最终真实报告：`.we-mcp/image-scene-verification/23ff99a1-24e2-4380-ad24-c24ce1ac7a3e/report.json`，passed:true、cleanupErrors:[]。同目录 config.json 可用于后续 MCP 访问 `managed/image-light`。项目和发布暂存目录写在 report.project / report.publish 中，本机保留，不上传图片。

| 检查 | 最终观察 |
| --- | --- |
| 原图到纹理 | 两个纹理实际编译成功；背景 TEX 1831594 字节、光点 TEX 7348 字节；两条模型→材质→纹理链共 6 个本地依赖。 |
| 图像内容 | 960×640 客户区与定向/sRGB 后原图的缩放结果比较，平均绝对 RGB 差约 0.681/255，明确为用户选择的图像。差值含 GPU/CPU 缩放算法差异，不是“无损屏幕输出”证明。 |
| 真实大小属性 | lightSize 32→96，受影响像素由 135 到 1205，中心变化小于 1 像素；不是仅以 CLI 返回值作证。 |
| 独立运动 | 提高速度和位移后，光点三帧水平跨度约 70.13 客户区像素，垂直跨度小于 1 像素；背景保持固定。 |
| 关闭光点 | 客户区像素与同次无光点背景参考逐字节一致，均差为 0。 |
| 保存/回滚/重开 | 保存隐藏默认值→新窗口实际隐藏→恢复 checkpoint 回到原 revision→旧窗口重载仍保留隐藏快照→重开显示原默认光点，均通过。 |
| 清理及数据 | 三个测试预览定向关闭，注册表 []，server.lock 不存在，scene-builds 为空；原图哈希不变，发布仅准备未上传。 |

最终工程 revision `ab749bdb3ecc1ce04ac59b3eebc3ec8fa4492805bb8e1d3c245ee6421e849e79`。查看过默认构图与恢复后截图，背景完整、光点位于左上方，不覆盖人物面部。精灵只是单个小光点，效果审美不应夸大为多层人物动画。

### 失败记录及原因

- `d82fdac2-cadc-4557-bbb0-3b6bd2f7da7d`：官方编译/截图成功，但验收把 CLI 物理像素尺寸再次乘 DPI。实测 120 DPI 下客户区仍为 960×640，WGC 为 962×679；修正脚本裁剪，未改 helper 或系统 DPI。
- `ef0ec717-9d23-4872-88f8-b16770293300`：引擎命令后短暂 “Done.” 提示及变暗遮罩影响整图对照。后续等待提示消退，不遮掉中间区域，也没有把全图变化当光点。
- `49c1ee1b-fec9-4c40-b01e-88ca9ec63a1d`：先前动态 Size 绑定静态/函数测试能通过，实际光点面积却没有响应。依据官方动态缩放示例改为 Scale；保留真实面积回归，证明修正后的变化。
- `6fecf41e-f80e-40be-8f10-4e84932ea9dd`：Scale、移动、隐藏通过，但新开窗口仍残留状态遮罩，跨窗口背景对照失败。最终脚本对打开窗口增加等待，对隐藏/保存/重载用最多 8 次完整像素匹配，超限仍失败，未降低判据。以上运行均定向关闭了自有窗口，原失败报告保留。

## 五项审查及回滚

1. **为何此方案**：复用图片安全入口、已有 Scene 模板、官方编译器和项目保存流程，补齐可由文本 MCP 客户端直接使用的图片创作入口。不重新实现专有资源编码。
2. **更简单的实现**：手动复制模板、执行构建脚本并改 JSON 也能做样例，但不能通过受限 MCP 直接处理任意指定图片；这个入口仅做固定两层，避免新建通用编译 DSL 或任意执行接口。
3. **架构与隐藏约束**：没有扩大公共文件根、改变工作区锁、丢掉原字节或绕过 validate。新建非原子、SceneScript 未全面静态检查、无跨进程预览并发锁等旧约束保留；新入口还受 8M 像素/预算限制。成功创建不改变 engineVerification:unverified 契约。
4. **绕路/硬编码/债务**：没有按图片名、哈希或人物坐标走分支；光点几何与相对位置是公开的固定预设。64×64 精灵和 Scale 的换算是资源尺寸关系。验收脚本针对这张 3:2 图使用 960×640 客户区和本机窗口裁剪，其他比例、系统/DPI 组合需另验；固定等待只处理宿主真实提示，负向对照仍要求完整像素相同。没有引入分割或超分模型。
5. **十倍规模先哪里出问题**：RGBA 纹理显存、原图/PNG/TEX/预览/检查点的重复磁盘空间、图片转码内存和串行队列等待。当前预算适合单工程，不预建任务池或缓存；批量需求出现后再设计配额/保留策略。

代码回滚基线 `f5fc9aa`：撤销本步提交可移除新入口及新测试，不删除已生成 Scene、原图、超分进度或旧媒体功能。已生成的工程包含标准运行资产，可继续交给官方引擎；若要撤销工程内文本编辑，用对应检查点与当前 revision。

本轮完成限定图片 Scene 闭环，**没有完成**任意 Scene 图层编辑器、人物/背景拆分、蒙版/粒子/骨骼、Scene 鼠标控制、超分、4K/HDR/多屏/长期性能或工坊上传。这张作品的精细动效和最终审美仍需用户验收。
