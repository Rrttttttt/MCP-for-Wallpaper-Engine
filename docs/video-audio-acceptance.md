# 视频创建与真实音频响应验收

2026-10-23，能力审计第 3 步。本轮只处理视频工程入口、限定样片的真实播放和受控系统音频响应；第 4 步多层 Scene 尚未开始，超分研究及图片入口保留。

## 开源比较与复用决定

开发前查阅 GitHub、官方文档与开发者社区。Star 为本次网页近似快照，不单独用来判断维护质量。

| 项目 | Star / 许可 | 功能、技术栈与维护依据 | 本轮采用范围 |
| --- | --- | --- | --- |
| [Lively](https://github.com/lively-community/lively)，原 rocksdanister/lively 地址当前重定向至此 | 约 19.9k / GPL-3.0 | C#、WinUI、Chromium、mpv/VLC；有播放器/API 文档和[发布历史](https://github.com/lively-community/lively/releases)。支持视频和音频驱动 Web 壁纸。 | 参考区分播放器、宿主音频输入和 Web API 的做法；不移植完整播放器，也不引入其 GPL 源码。 |
| [linux-wallpaperengine](https://github.com/Almamu/linux-wallpaperengine) | 约 4.7k / GPL-3.0 | C++、OpenGL、CEF、FFmpeg/MPV、PulseAudio/FFTW；README 有构建说明，[提交历史](https://github.com/Almamu/linux-wallpaperengine/commits/main/)可见 2026 年维护。 | 参考视频/Scene/Web 类型边界；Linux 音频与窗口实现不能直接替代本机官方引擎。 |
| [mediainfo.js](https://github.com/buzz/mediainfo.js) | 上一步快照 873 / BSD-2-Clause | 已安装 0.3.8，TypeScript + MediaInfo WASM，已有有界子进程探测。 | 直接复用现有探测、源哈希和资源限制，不新增另一套媒体依赖。 |

采用已有项目模块和官方引擎集成。官方 [Web 参考](https://docs.wallpaperengine.io/en/web/overview.html)说明 Web 内视频支持 WebM/OGG/OGV，不能由原生 MP4 播放成功推导 CEF 中 MP4 可播。官方[音频文档](https://docs.wallpaperengine.io/en/web/audio/visualizer.html)要求提前注册一次监听器。[开发者旧指南](https://steamcommunity.com/sharedfiles/filedetails/?id=786006047)明确音频启用字段位于 `general`；旧指南的 onload 注册建议已被现行文档替代，本轮只参考字段位置，并与本机官方项目核对。

## 实现与调用关系

| 文件 | 修改与原因 |
| --- | --- |
| `src/media.ts`、`src/index.ts` | 新增 `we_video_create`：复用 assetRoots → 有界字节读取 → 源哈希 → 隔离元数据探测 → 视频轨道确认 → 新工程写入。工具总数 20，默认仍为文本输出。 |
| `src/projects.ts` | 将已有新建保存流程提取为 `createFiles`，供模板、源工程副本、视频共用；保留名称、只写受管区、静态校验、独占目录、移除 workshopid 和 origin 记录。修正共享音频字段检查。 |
| `src/engine.ts` | CEF bind 只处理 Web，避免原生 Video/Scene 把不存在的调试端口记录为无关抓图错误。原生窗口归属、截图与关闭约束不变。 |
| `templates/web-starfield/project.json`、`wallpaper.js` | 音频标记改到 `general.supportsaudioprocessing`；增加注册状态、实际低频均值、实际绘制增益的固定诊断。音频关闭仍继续接收回调，但绘制增益为零。 |
| `test/media.test.mjs`、`core.test.mjs`、`stdio.test.mjs`、`web-limit.test.mjs`、`workspace-lock.test.mjs` | 视频原字节、拒绝覆盖/错误哈希/音频文件/取消、复制与发布；字段位置、音频开关；真实 STDIO 新工具；原生不探测 CEF；锁诊断模式覆盖全部普通工具。 |
| `scripts/verify-av.mjs`、`play-test-tone.ps1`、两个 motion 样片及其 README | 显式启动的真实引擎验收，不进入普通测试，也不是公开播放工具。样片仅合成图案；不提交编码器或用户媒体。 |
| `README.md`、`docs/media-import.md`、`docs/capability-audit-followup.md`、本文 | 更新接口、兼容影响、证据和剩余范围，保留历史失败结论。 |

先用 `we_media_inspect` 获取源哈希，再调用：

```json
{"name":"we_video_create","arguments":{"name":"my-video","title":"My video","sourceRoot":0,"sourcePath":"clip.mp4","expectedSourceHash":"<inspect 返回的 SHA256>"}}
```

生成 `managed/my-video`，包含 `project.json`（type:video）与 `wallpaper.mp4` 或 `wallpaper.webm`，不遗留 Web 模板资源。必须有视频轨道；WAV/MP3、错误哈希、未配置素材根及同名工程被拒绝。容器以探测结果为准，目标文件名由服务生成。沿用单媒体 40 MiB、已知时长最多 1 小时、工程 64 MiB / 2000 文件等预算，无转码、下载或任意命令执行。

新建前检查候选工程，之后独占创建目录；这不是跨文件原子提交。沿用原有新建行为：写入中途故障可能留下不完整的新目录，不能盲目同名重试；没有覆盖已有工程或自动删除现场。取消在保存开始前生效，已开始的保存不承诺回滚。既有工程修改仍使用 revision / checkpoint / operation journal。

创建回执仍含 `media.validation:metadata-only`、`media.playability:unverified` 和静态 `engineVerification:unverified`。样片实测成功不会把任意上传素材标成可播放。用 `we_preview_open`、`we_preview_observe`（原生视频选 native）、`we_preview_close` 验证具体工程。

## 两个根因及回归

1. 原生观察路径无条件调用 CEF bind。真实视频已有图像，却返回 issues:[fetch failed]；新增公共 observe 回归测试，修复前原生视频触发两次调试端点请求而失败。给共享 bind 添加 Web 类型条件后回归通过，Video/Scene 不再探测 CEF。
2. 模板根节点 `supportsaudioprocessing` 无法启用宿主音频，校验器也只检查这个错误位置。真实测试音期间 audioCallbacks=0。本机官方 Audiophile、Corsair-O-Tron 与开发者字段说明均使用 `general.supportsaudioprocessing`。新增回归先证明合法 general 标记被误拒绝，再修正模板/共享检查，真实回调随之出现。

兼容影响：只有旧根节点标记的历史 Web 工程，现在 inspect 会报告校验失败，预览、发布、复制或恢复此类候选也可能被拒绝。受管工程可 inspect 后以当前 revision 对 manifest 做显式 apply：将标记移到 general，保留其他字段，再重新开预览。没有批量迁移原作品或修改旧检查点。原审计星空就属于这个历史情况；其原始文件保持不动，不能说已自动修复这个现场。

## 测试与真实验收

| 命令 | 最终结果 |
| --- | --- |
| `npm.cmd test` | 构建成功，62/62，通过，0 失败、0 跳过，92.6 秒。覆盖修正后的生产代码。 |
| `node --check scripts/verify-av.mjs`、`git diff --check` | 通过。后续修改仅验收脚本和文档，未再改生产逻辑。 |
| `node scripts/verify-cef.mjs`，正常桌面权限 | 重启引擎后通过截图、属性、可信鼠标事件、错误日志及宿主重载；报告 `ef83cc40-fa27-4602-b054-adc55db3549a`。 |
| `node scripts/verify-av.mjs --audio-only`，正常桌面权限 | 最终加强后的独立音频对照通过，报告 `23e05177-677a-4818-92fb-ee7e30fedbf3`。 |
| `node scripts/verify-av.mjs`，正常桌面权限 | 最终四分支全部通过，passed:true、cleanupErrors:[]；原始报告 `.we-mcp/av-verification/91434d77-c060-4231-8840-bf374a9fc57e/report.json`。 |

本机官方引擎 2.8.42、Windows 11 build 26100、既有 Windows Graphics Capture 助手。新工作区与固定自有窗口，不切换桌面壁纸、不调整系统音量、不写用户原工程。调试参数已存在，本轮只在既有授权下重启引擎，没有改写安装目录配置。自动壁纸轮换可能正常推进，没有恢复过期桌面选择。

最终四项证据：

| 路径 | 观察 |
| --- | --- |
| 原生 MP4（AVC High，160×90、12 FPS、2 秒、无音轨） | 自有原生窗口 3 张 PNG；中心采样内容与首帧差异为 9.50、17.50，确认不同视频图案帧。 |
| 原生 WebM（VP9，相同尺寸/时长、无音轨） | 3 张 PNG；内容差异 15.08、15.08，确认不同图案帧。 |
| Web 中静音 WebM | CEF decodedFrames 从 8 到 42，readyState:4、paused:false、error:null，并有变化的图案帧。 |
| 真实系统音频响应 | SoundPlayer 播放 110 Hz / 48 kHz / 8 秒 / 3% 数字峰值 PCM；实际 host 回调增长，低频均值从约 1.47e-8 到 0.00917；关闭响应时仍有输入而 renderedAudioGain=0，结束后输入回落。声音开启的像素均差约 0.00935，关闭响应和结束后均差均为 0。 |

像素均差是中心 60% 区域缩到 80×45 后的 8 位 RGB 平均绝对差，原 PNG 保留。音频为小幅度响应，数值可证明受控像素变化，不能代替音乐观感或灵敏度验收。音频测试复制真实模板，设置 speed=0，并仅在新建测试副本中删去 mousemove 监听器以关闭视差；音频注册、处理和绘制保持逐字一致，两个脚本哈希写入报告。没有模拟宿主 FFT、手调 bass 或改正式模板来迁就验收。

读取检查过原生 MP4、WebM/CEF 与星空 PNG，确认为图案或星空内容；单次图像检查不能验证帧率和声音。脚本同时核对素材源哈希不变、预览注册表为空、锁释放。原审计星空 revision 仍为 `0827accf778ff524aeb899ffc6d7d7aaa89d21a8564597c2f7575a0cf1e12d9d`；人像工程仍为 `b92d8d1040f838af4ae6fe9d173f3f4cc39f8a96504d3b5592d2beafa9f44027`。

### 保留的失败与中断证据

不把早先失败改写成成功。报告均留在忽略的 `.we-mcp` 下：

- 引擎起初没有可用预览，CEF 复验 `d04889c3-46b0-4d14-b925-d66f8ab5eb8d` 报 WINDOW_NOT_FOUND；一次启动交接后无存活引擎，复验 `1aa8b903-2a24-4889-abe6-9714b3dcfb54` 报 CLI_FAILED。随后核实没有实例并后台启动，原复现脚本转为通过。这只证明重启后恢复，未证明旧进程为何失去预览能力。
- AV 报告 `ceb1d70f-95bb-4b7c-8f25-42654b45919c` / `08f5efd0-54c6-4d28-8f23-1be4590dc10a` 分别记录原生无关 CEF 错误和零音频回调。
- `a0d3840e-de77-4c77-93b3-0f1df93bb74c` 曾在预览期间连接关闭，原因未确认，留下窗口/锁；不能据此声称解决了任意传输中断。先用 we_workspace_diagnose 证明 PID 43956 已退出，再核实该次自有窗口身份并定向关闭，最后 we_workspace_recover 携当前指纹归档恢复；`interruption-cleanup.json` 保留回执。未直接删除锁、修改锁服务或接管旧预览。之后复验的旧预览缺失是此中断的后续环境干扰，不算音频字段修复失败的证据。
- 字段修复后 `ed40dc57-7ab4-46bd-9aea-d5ab91493611` 已有真实输入，但最初固定 0.01 阈值高于低幅测试音的 16 频段均值；改为最低 0.001 且至少安静对照 10 倍，并保留回调、渲染、像素双对照。
- `ae7de965-5371-40de-b41b-8ea0b2ca078f` 的像素对照失败；仅固定虚拟指针的中间报告虽然判通过，仍存在基线漂移。最终验收移除测试副本的视差输入，并要求关闭响应及音结束后的像素均差均≤0.001，原始中间结论不作最终依据。

## 五项审查、风险与回滚

1. **为什么此方案**：原字节视频创建只需复用已有探测和新建模块；播放交给官方引擎，音频修复位于模板与共享校验根因。省去播放器、转码器及新的公开音频控制面。
2. **有没有更简单的实现**：手动先建 Web、导入视频、再改 manifest 可行，但会留下无关模板资源和额外状态。新增小工具和共享保存流程让文本 MCP 客户端直接完成新建；没有加插件框架或新依赖。
3. **隐藏约束**：保持受管区、revision、检查点、窗口身份及工作区锁边界。音频字段检查更严格会拒绝历史错误元数据；新建仍非跨文件原子事务。两者明确告知，没有暗中迁移或扩大目录权限。
4. **绕路或技术债**：未新增通用 eval、任意执行、系统音量/静音或桌面截图工具。测试使用明确的合成样片和受控副本，不按用户作品名走特殊分支。FFT 检测预算是限定刺激的验收标准；不会把它当作所有音频的产品阈值。传输异常根因、非原子新建和历史截图不自动清理仍是已知边界，未顺手重构。
5. **十倍规模先哪里出问题**：媒体和整工程缓冲、快照/检查点/截图磁盘占用、串行工具队列；此外每会话只限制一个 Web，不能推导跨服务进程并发安全。当前有限预算保持，有实测负载再决定处理策略。

代码回滚基线 `0e6fd4f`：撤销本步提交可移除新视频入口、诊断与本步修复，不删除既有工程、超分进度或本地报告。回滚也会撤回音频字段和原生 CEF 误探测修复；新工程含正确 general 标记时，旧校验器可能误拒绝，应明确评估再回滚。新建没有“之前版本”的检查点；本轮验收副本的后续文本修改有普通检查点。

未验收：任意 MP4/WebM 的完整解码、AAC/MP3/视频音轨在引擎中的实际输出、CEF 内 MP4、HDR/4K/多屏/长期性能、系统媒体会话、音频设备切换/独占模式、任意旧作品的自动迁移。下一独立任务为第 4 步用户图片 → 官方纹理编译 → 两层 Scene → 属性绑定 → 真实截图，等用户确认后开始。
