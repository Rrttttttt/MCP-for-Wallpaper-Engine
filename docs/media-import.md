# 音视频素材导入与元数据

2026-10-23，能力审计第 2 步。新增 WAV、MP3、MP4、WebM 的受限探测与原字节导入，继承既有图片入口的路径、覆盖保护和工程检查点。没有实现视频工程模板、转码或真实音频/视频播放验收，超分进度保留。

后续第 3 步新增 `we_video_create` 并进行限定样片的真实播放与系统音频响应验收，见[后续记录](video-audio-acceptance.md)。本文以下保留第 2 步交付时的范围；素材探测返回的 metadata-only / playability:unverified 契约不变，不会因样例验收通过而宣称任意文件可播放。

## 开源比较及决定

开发前查阅 GitHub、官方文档、npm registry 与上游 issue；Star 是本次网页近似快照。

| 项目 | Star / 许可 | 技术栈与维护证据 | 决定 |
| --- | --- | --- | --- |
| [mediainfo.js](https://github.com/buzz/mediainfo.js) | 873 / BSD-2-Clause | TypeScript + Emscripten/WebAssembly，基于 C++ MediaInfoLib；registry 0.3.8，修改时间 2026-09-18；本地实测 MediaInfoLib 26.05。 | 固定 0.3.8，复用缓冲区元数据解析；不移植 GUI，不要求用户安装本机媒体可执行程序。 |
| [music-metadata](https://github.com/Borewit/music-metadata) | 约 1.3k / MIT | TypeScript，音视频媒体元数据 API；registry 12.2.3，修改时间 2026-10-18，文档完整。 | 同样可行；本轮采用 MediaInfo 的统一轨道输出，不同时引入两套解析库。 |
| [FFmpeg / ffprobe](https://github.com/FFmpeg/FFmpeg) | 约 65.6k / LGPL-2.1-or-later，具体构建可能启用 GPL 等组件 | C；官方 [ffprobe 文档](https://www.ffmpeg.org/ffprobe.html)完整，支持流与容器探测。本机 PATH 未配置 ffprobe/ffmpeg。 | 后续转码/解码可用，本轮不作为服务运行依赖；许可须看[实际构建](https://www.ffmpeg.org/legal.html)，不能以项目名称推导二进制许可。 |

参考上游 [buffer 使用说明](https://mediainfo.js.org/docs/getting-started/usage/)、[JSON 输出问题 #159](https://github.com/buzz/mediainfo.js/issues/159)及[早期挂起报告 #2](https://github.com/buzz/mediainfo.js/issues/2)。旧报告不证明当前版本仍有同一问题；本服务仍独立设置期限、输出限制和取消，并验证实际子进程退出。

本仓库新增依赖和锁文件，未拷贝修改 MediaInfo 源码。npm 包携带 WASM 与 BSD-2-Clause LICENSE；部署时应保留依赖许可证和 WASM，不能只复制 JS。其 yargs 依赖来自上游 CLI，服务本身使用库 API，不调用其 CLI。

## 接口

使用现有 `assetRoots` 配置，只启用明确素材目录，默认仍为 `[]`。两个工具默认纯文本，不传输 base64 媒体块、不读取 URL、不播放文件。

```json
{"name":"we_media_inspect","arguments":{"sourceRoot":0,"sourcePath":"clip.mp4"}}
```

返回 `media.kind`、container、durationSeconds、audio/video 轨道、编码格式、尺寸/帧率/旋转信息、声道/采样率、字节数、SHA256 和解析库版本。字段可能缺省；时长可能包含编码延迟/填充。旋转信息未用于改写尺寸，不能当作引擎实际显示方向的验收。不返回封面、标题、艺术家、章节及任意原始标签。

```json
{
  "name":"we_media_import",
  "arguments":{
    "projectId":"managed/my-wallpaper",
    "expectedRevision":"<工程当前 revision>",
    "sourceRoot":0,
    "sourcePath":"clip.mp4",
    "expectedSourceHash":"<inspect 返回的 media.sha256>",
    "targetPath":"media/clip.mp4",
    "overwrite":false
  }
}
```

导入同一经过探测的 Buffer，不重新读取源后再保存；预期源哈希不符即拒绝。目标只能是受管工程内的普通相对路径，扩展名必须匹配探测格式。默认拒绝覆盖，显式覆盖还要求目标大小写匹配；字节完全相同的覆盖沿用 replace 的无修改行为，不生成新检查点。成功返回新 revision、checkpointId，可用 `we_project_restore` 恢复。

格式按字节签名初筛，再用 MediaInfo 确认容器和轨道，不只看扩展名。WAV 另检查基本声明大小，MP3 须识别到 MPEG Audio Layer 3；MP4 使用 ftyp 与 MPEG-4 容器识别，WebM 须识别为 WebM。视频预算为单边 8192、16,777,216 像素、最多 240 fps；音频最多 8 声道、192 kHz。未知时长/未知必需参数、时长超 1 小时、报告加密或超过 32 个原始轨道的输入拒绝。此范围会保守拒绝部分合法特殊媒体。

## 边界与取消

- 单素材 40 MiB，工程仍为 64 MiB / 2000 文件；不扩大整个工作区预算。模型、测试编码器及探测临时数据不加入工程，保存前沿用候选静态验证。
- `assets.ts` 抽出原图片入口的有界句柄读取、链接/额外硬链接拒绝、读前后属性核对、revision 检查、已有文件/空目录大小写与覆盖检查。图片原有 20 MiB 预算和错误码保留，并重跑原测试；源目录保持只读。
- 解析程序只收到字节 Buffer，通过 analyzeData 回调读取其中片段，不接受用户路径、命令或可执行参数。WASM 从已安装 npm 包加载，不因媒体中的引用获取网络/外部文件。
- 每次解析是独立 Node 子进程，5 秒期限、stdout/stderr 各 128 KiB 上限，V8 old-space 配置 256 MiB。WASM 线性内存和总 RSS 不受该 V8 参数硬限制；本轮没有宣称 OS 沙箱或总内存硬隔离，极端内存压力尚未验收。
- MCP 请求取消信号与服务退出信号组合后传入探测子进程。取消尚未保存的导入，不生成素材或检查点；进入既有 replace 保存流程后沿用其事务/恢复语义，取消不等于回滚。服务仍等待在途操作清理后释放锁，不强杀整个引擎。
- `MEDIA_FORMAT` 为不支持/未确认容器或轨道；`INVALID_MEDIA` 为明显损坏或无效结果；`MEDIA_LIMIT` 为预算不足；`MEDIA_PROBE_FAILED` 为子进程失败/超时/输出超限；`MEDIA_CANCELLED` 为收到取消。哈希、revision、只读来源及覆盖错误沿用既有保护。
- `validation:metadata-only`、`playability:unverified` 始终保留。探测不完整解码，部分截断或坏帧仍可能被识别；容器/编码器名称也不证明 CEF/官方引擎支持。没有播放音频、测量实际帧呈现、验证系统频谱或自动把引用写入 HTML。M4A/AAC/Ogg/FLAC/MKV 等未包含在本轮白名单。

## 验证

```powershell
npm.cmd test
node scripts/verify-media-import.mjs
node scripts/verify-media-import.mjs 'F:/SteamLibrary/steamapps/common/wallpaper_engine/projects/defaultprojects/dino_run/sounds/coin2.wav' 'F:/SteamLibrary/steamapps/common/wallpaper_engine/ui/dist/videos/previews/03ac8a19b3a32666.webm'
node --check scripts/verify-media-import.mjs
git diff --check
```

测试输入为本项目自生成的短 WAV/MP3/MP4/WebM，所有文件合计约 16 KiB；生成命令、字节数与 SHA256 见 [fixture 说明](../test/fixtures/media/README.md)。编码器仅用于固定合成信号，保留在本机忽略目录，不加入运行依赖。标准测试不要求 FFmpeg 或官方引擎。

真实 WASM 专项覆盖四格式、音视频混合/纯视频、时长、尺寸、帧率、旋转数值、声道、采样率、哈希、不泄露标签、原字节导入、默认拒绝覆盖、显式替换/恢复、同字节无变更、源变化、旧 revision、格式扩展名不符、只读工程、路径遍历、链接/硬链接、文件超限、明显损坏及预先取消。原有图片入口回归通过。

真实 STDIO 覆盖工具发现（19 个）、纯文本探测与导入、落盘字节、检查点恢复；锁诊断模式拒绝两个新工具。测试专用 preload 仅替换媒体子进程，使它实际挂起：5 秒后超时退出且会话仍可用；服务 EOF 取消在 SDK 强杀前结束，锁释放、新会话可接管；单次 MCP 请求取消在不关闭客户端的情况下终止子进程，工程 revision 不变、无素材/检查点。测试开发时修正过旧 SDK 的第三参数位置，并增加早于自然超时结束的断言，避免误把超时当取消成功；当前使用 SDK 2.3.1 的 `ctx.mcpReq.signal` 和客户端第二参数 options。

最终代码的独立验收脚本经真实 MCP 对四个合成素材完成 inspect → import → 哈希核对 → restore，原始回执：`.we-mcp/media-import-verification/4a7ca41c-d1ed-4009-9a54-415d6ed6aa2d/report.json`。本机安装目录内的 WAV/WebM 也完成同链路，回执：`.we-mcp/media-import-verification/b154688e-ec65-44cb-b1b7-b74db31bfa29/report.json`；两次均源文件未变、锁释放。安装目录素材仅用于本机验证，未提交进仓库。

本机 WAV：0.385 秒，单声道 44.1 kHz、34,008 字节；WebM：3 秒、VP9、256×256、20 fps、49,429 字节。本轮没有打开引擎预览；之前的当前引擎环境验收失败保持记录，不因媒体探测通过而改为成功。最终 `npm.cmd test` 构建及 59/59 测试通过、0 失败、0 跳过，约 88.2 秒；验收脚本语法检查与 git diff --check 通过。

未验收：完整解码/播放、视频工程模板、系统音频真实回调、加密/多轨/异常元数据全矩阵、强制 OS 内存上限、长期压力、跨机器性能和所有特殊容器；下载的测试编码器不作为本机任意媒体处理方案推荐。

## 文件审查与回滚

主要文件：`src/assets.ts`、`src/images.ts`（共用保护），`src/media.ts`、`src/media-probe.ts`（新入口/隔离探测），`src/index.ts`（注册与取消），package/lock（固定依赖），媒体/退出/STDIO/锁测试及合成 fixtures、独立验收脚本、README、本文与能力审计跟进。

1. **为什么选择**：MediaInfo 的 Buffer API 统一提供音视频轨道，不依赖本机可执行路径；原工程保存、锁、检查点已存在，只需复用。隔离解析、超时与取消针对实际客户端退出约束。
2. **更简单的实现**：直接复制文件最短，但缺少容器/轨道信息；本机已有 ffprobe 时也可调用它。当前首版只增加两个窄工具，不增加转码、媒体播放器或任务平台。
3. **架构和隐藏约束**：仅从图片模块抽出两个真实共用函数，保留现有错误码和预算。总工程限额、串行队列及检查点不变；SDK 请求信号只被新媒体工具消费，其他工具行为保持原契约。中途取消不破坏已开始的保存流程。
4. **绕路/技术债**：没有用文件名或进程退出码冒充完整有效性，没有对真实作品做特殊分支。metadata-only、有限白名单、old-space 非 RSS 总限制是明确范围；上游 yargs 属依赖成本，未为了减包擅自复制 WASM/删改上游发行内容。
5. **十倍规模先哪里出问题**：40 MiB 输入缓冲区、逐次 WASM 初始化、整工程读入与全量检查点先影响内存/磁盘/延迟。保留单次有界处理；有批量实测需求再决定流式读入、进程复用和检查点保留策略。

回滚基线 `b317d46`；撤销本步提交可移除媒体入口和恢复图片模块组织，不删除已有工程。已导入素材另用返回的 checkpointId 恢复。下一步是第 3 步的视频创建/播放与受控真实音频响应验收，需在当前引擎可用后完成；本轮止于素材入口。
