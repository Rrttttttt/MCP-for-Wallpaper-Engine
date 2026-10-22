# 图片超分后端选型与 MCP 接入研究

2026-10-22，第 1 步：搜索和方案分析。本轮没有下载程序或权重、运行超分、修改 MCP 工具或替换工程图片。以下是上游文档和源码证据，不是本机兼容性、速度或画质验收。

## 研究结论

建议首轮使用 **Real-ESRGAN ncnn Vulkan 的外部 CLI** 验证 `realesr-animevideov3` 的 2 倍输出，并以 **Real-CUGAN ncnn Vulkan 2 倍**作动漫图片对照。复用推理程序和模型格式，为本项目写有边界的调用与结果校验，暂不移植神经网络或整套桌面 GUI。该结论针对接入成本；两个模型在实际壁纸上的画质优劣仍需同图比较，不能依据 README 示范图认定。

Real-ESRGAN 原始 ncnn 后端已有 Windows 命令行和 tile 参数，源代码为 MIT；Real-CUGAN 的 ncnn 后端同为 MIT，专门面向动漫超分。两者官方可执行包较旧，必须实际验证当前驱动、输入格式和路径。来源：[Real-ESRGAN ncnn 使用说明](https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan#computer-usages)、[其 LICENSE](https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan/blob/master/LICENSE)、[Real-CUGAN ncnn 使用说明](https://github.com/nihui/realcugan-ncnn-vulkan#usages)、[其 LICENSE](https://github.com/nihui/realcugan-ncnn-vulkan/blob/master/LICENSE)。

## 候选项目比较

Star 为查询时网页/API 的近似快照，不代表质量或维护保证；表中“可见提交”指本次获取页面展示的最新记录，不使用 updated_at 推断维护。Spandrel 的提交页未能读取，保留未核实状态。

| 项目及技术栈 | Star 快照 | 代码许可 | 维护证据 | 本项目判断 |
| --- | --- | --- | --- | --- |
| [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN)，Python / PyTorch / BasicSR | 约 37.2k | [BSD-3-Clause](https://github.com/xinntao/Real-ESRGAN/blob/master/LICENSE) | [可见最新提交 2024-04-02](https://github.com/xinntao/Real-ESRGAN/commits/master/)，主要推理代码与 v0.3.0 发布来自 2022 年。 | 模型及推理参考完整；通用/动漫模型多，但增加 Python/Torch 部署成本，不作首轮最小依赖。 |
| [Real-ESRGAN-ncnn-vulkan](https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan)，C/C++ / ncnn / Vulkan | 2,252 | MIT，含上游 realsr 声明 | [API pushed_at 为 2024-05-10](https://api.github.com/repos/xinntao/Real-ESRGAN-ncnn-vulkan)；[官方 README 链接的 Windows 包](https://github.com/xinntao/Real-ESRGAN#portable-executable-files-ncnn)为 20220424。 | 首选外部 CLI 验证，不能称为持续频繁更新的项目。 |
| [Real-CUGAN-ncnn-vulkan](https://github.com/nihui/realcugan-ncnn-vulkan)，C++ / ncnn / Vulkan | 931 | MIT | [可见最新提交](https://github.com/nihui/realcugan-ncnn-vulkan/commits/master/)与[最新发布](https://github.com/nihui/realcugan-ncnn-vulkan/releases)均为 2022-07-28。 | 动漫线条、保守修复的有意义对照；旧二进制兼容性待测。 |
| [Upscayl](https://github.com/upscayl/upscayl)，Electron / TypeScript；[upscayl-ncnn](https://github.com/upscayl/upscayl-ncnn)，C++ / ncnn / Vulkan | GUI 约 50.9k；CLI 476 | [GUI AGPL-3.0](https://github.com/upscayl/upscayl/blob/main/LICENSE)；[CLI AGPL-3.0](https://github.com/upscayl/upscayl-ncnn/blob/master/LICENSE) | [GUI 可见 2026-03-27 提交](https://github.com/upscayl/upscayl/commits/main/)，[CLI 可见 2026-04-11 提交](https://github.com/upscayl/upscayl-ncnn/commits/master/)。 | 比原始后端更新，可参考其分辨率和模型管理；不需要移入 GUI。不能因它 fork 自 MIT 项目就把其新增代码当作 MIT。 |
| [Spandrel](https://github.com/chaiNNer-org/spandrel)，Python / PyTorch 模型加载库 | 315 | [MIT](https://github.com/chaiNNer-org/spandrel/blob/main/LICENSE)，额外架构另分包 | [发布页](https://github.com/chaiNNer-org/spandrel/releases)显示 v0.4.2 和其后提交；本次未核实该发布年份及最近提交日期。 | 将来支持更多模型时有用；不是即装即用图片 CLI，首版接入成本更高。 |

## 参数和运行约束

### Real-ESRGAN ncnn：先区分模型倍率和输出倍率

帮助列出 `-s 2/3/4`，但源码只为 `realesr-animevideov3` 按倍率选择 `-x2/-x3/-x4` 模型文件；其他名称直接选择固定文件。官方模型表把 `RealESRGAN_x4plus`、动漫 6B 等列为 X4。**不能对固定 x4 模型随意传 `-s 2` 并声称得到了合法的原生 2 倍推理。** 首轮应按真实模型和文件名白名单固定组合。来源：[CLI 模型选择源码](https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan/blob/master/src/main.cpp)、[官方模型表](https://github.com/xinntao/Real-ESRGAN/blob/master/docs/model_zoo.md)、[动漫视频模型说明](https://github.com/xinntao/Real-ESRGAN/blob/master/docs/anime_video_model.md)。

候选命令形式如下，尚未执行；需要先核对固定版本二进制的帮助、实际模型文件和哈希，不能仅按 master 的接口假定旧发布完全相同：

```text
realesrgan-ncnn-vulkan.exe -i <输入副本.png> -o <新输出.png> -m <已核对模型目录> -n realesr-animevideov3 -s 2 -t 128 -j 1:1:1 -f png
```

`-t` 为 tile 大小，较小 tile 用来控制局部推理显存，不代表总输出内存也有界；TTA 默认先关闭。CLI 使用 Vulkan GPU，其当前源码拒绝负 GPU 索引，不能擅自把 `-g -1` 当作 CPU 回退。来源：[CLI 参数和设备校验](https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan/blob/master/src/main.cpp)、[README](https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan#full-usages)。

### Real-CUGAN ncnn：2 倍与保守模式对照

官方提供无需 CUDA/PyTorch 环境的 Windows 可执行包，参数包含 `-s`、`-n`、`-t` 和 CPU 设备 `-g -1`。首轮可先比较 `models-se` 中的 2 倍保守模型；其 `-n -1` 在源码中选择 `up2x-conservative`，`-n 0` 为 `up2x-no-denoise`。必须核对下载包实际具有对应 `.param/.bin`，不能假定所有目录都支持所有降噪/倍率组合。来源：[官方使用说明](https://github.com/nihui/realcugan-ncnn-vulkan#full-usages)、[模型文件与设备选择源码](https://github.com/nihui/realcugan-ncnn-vulkan/blob/master/src/main.cpp)。

```text
realcugan-ncnn-vulkan.exe -i <输入副本.png> -o <另一新输出.png> -m <保留models-se名称的目录> -s 2 -n -1 -t 128 -j 1:1:1 -f png
```

这里不承诺 Real-CUGAN 更清楚或更保真；上游[对比说明](https://github.com/bilibili/ailab/tree/main/Real-CUGAN#1-效果对比)也包含线条、虚化和纹理取舍。作者样例不是本项目图片的验收证据。

### 其他候选的边界

- Upscayl 当前 CLI 源码将模型倍率 `-z` 与最终输出倍率 `-s` 分开，并有 `-r/-w` 后处理尺寸选项；接口与原始 Real-ESRGAN ncnn 不同，不能共用未经版本区分的参数模板。[CLI 源码](https://github.com/upscayl/upscayl-ncnn/blob/master/src/main.cpp)。
- Spandrel 要求 Python >=3.10，并依赖 torch/torchvision 等；它自动识别模型结构，但不替调用者完成图像到 tensor 转换和完整图片处理。核心库的许可不能代替任意社区权重或 extra_arches 的许可。[包定义](https://github.com/chaiNNer-org/spandrel/blob/main/libs/spandrel/pyproject.toml)、[README](https://github.com/chaiNNer-org/spandrel#basic-usage)。
- Python Real-ESRGAN 的 `outscale` 与 `netscale` 不同，可以在原生模型推理后调整最终尺度；还提供 tile 与 alpha 处理选择。该能力不应被误写为原始 ncnn 所有固定 x4 模型都可直接原生 2 倍。[Python 推理入口](https://github.com/xinntao/Real-ESRGAN/blob/master/inference_realesrgan.py)。

## 集成时必须处理的四项风险

1. **结果不等于真实细节恢复。** Upscayl 官方 FAQ 将增强细节解释为模型估计，并说明严重失焦模糊不是其擅长的输入；线条、肤色、虚化和噪点应在同一显示尺度做裁切对照，不能把尺寸变大等同于画质变好。[官方 FAQ](https://github.com/upscayl/upscayl#faq)。
2. **成功退出不等于有效输出。** Real-ESRGAN ncnn 当前源码中图片解码/编码失败可只记录日志，主流程最后仍返回 0。MCP 必须确认输出是本次新建文件、可完整解码，核验实际尺寸、通道、字节及像素限制；不能只检查进程退出码或 PNG 文件名。[load/save/main 源码](https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan/blob/master/src/main.cpp)。
3. **RGBA 支持不等于透明边缘被 AI 修复。** Real-ESRGAN ncnn 与 Real-CUGAN 的源码均将 alpha 分开，以 bicubic 放大后合并 RGB。须实际检查透明边缘、黑白背景下的晕边；蒙版应保持独立的坐标和缩放规则。[Real-ESRGAN alpha 源码](https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan/blob/master/src/realesrgan.cpp)、[Real-CUGAN alpha 源码](https://github.com/nihui/realcugan-ncnn-vulkan/blob/master/src/realcugan.cpp)。
4. **代码许可、模型权重和二进制分发分别核对。** 首版建议配置本地可执行文件与本地模型目录，并记录版本/哈希/来源；不自动把第三方权重和完整上游应用提交进本仓库。以下许可台账明确目前证据，不能用外部进程调用方式直接推导任何许可义务结论。

## 模型与分发许可台账

| 对象 | 已核实 | 尚未核实 / 集成约束 |
| --- | --- | --- |
| Real-ESRGAN / ncnn 源码 | 原 Python 项目 BSD-3-Clause；原 ncnn 实现 MIT，许可证还保留 realsr 声明。 | 模型是独立资产。官方[issue #677](https://github.com/xinntao/Real-ESRGAN/issues/677)专门询问 checkpoints 分发条款，当前仍 Open，所读页面未见作者明确澄清。本轮不宣称 MIT 或 BSD 已独立覆盖每个权重。 |
| Real-CUGAN | ncnn 实现 MIT；原模型作者 bilibili 的 [Real-CUGAN 目录 LICENSE](https://github.com/bilibili/ailab/blob/main/Real-CUGAN/LICENSE)也为 MIT。 | 仍需取得所选发布包内权重、随包许可和来源对照；未下载包，不声称逐文件再分发许可核验完成。 |
| Upscayl / upscayl-ncnn | 两个当前 LICENSE 均为 AGPL-3.0。 | 复制修改源码、分发二进制与本地调用是不同集成行为；本报告不推断任一行为自动豁免义务。其自定义模型来自不同作者，不能把后端许可覆盖到全部模型。 |
| Spandrel 与自选权重 | 核心库 MIT；README 将额外受限架构分入 extra_arches。 | 每个权重的来源、训练许可和模型卡需另查；支持加载该模型不代表模型本身具有相同许可。 |

## 本轮未验收

未下载或执行任何超分程序/模型，未测试本机 Vulkan 设备枚举、新 GPU 与旧发布的兼容性、OOM/超时/退出清理、中文路径、ICC/色彩管理、EXIF、16-bit 图片、透明通道、分块接缝或实际壁纸观感。不同模型参数不能直接比较“同名倍率”而忽略原生模型结构。以固定包和同一输入副本完成最小验证后，才能决定最终后端与默认模型。

## 本机与现有工程核对

本轮只读查询结果：NVIDIA GeForce RTX 5060 Laptop GPU，`nvidia-smi` 报告显存 8151 MiB、驱动 616.56；Win32_VideoController 对该设备报告当前 2560×1440，另列 Intel Graphics 和虚拟显示设备。该尺寸不是对所有显示器拓扑的验收，也不证明旧版 Vulkan 二进制已经兼容此显卡。

实际检查的样例为 `.we-mcp/creations/jianyue/data/projects/jianyue-free-breeze-1792648082229/artwork.png`：PNG IHDR 为 1672×941、RGB，文件 1,920,919 字节，并已查看图像，属于有柔和笔触的动漫人物插画。目标不只是强化锐度，还应保留眼睛、眼镜、发丝、珠链与原有虚化风格；这使动漫模型对照有实际意义。

| 方案 | 输出尺寸 | 像素数 | 本项目判断 |
| --- | --- | --- | --- |
| 原图 | 1672×941 | 1,573,352 | 在系统当前报告的显示尺寸下需放大采样；这是尺寸事实，未据此测量主观画质损失。 |
| 2 倍 | 3344×1882 | 6,293,408 | 首轮优先验证；保持原始宽高比，最终仍按视口适配。 |
| 4 倍 | 6688×3764 | 25,173,632 | 增加纹理和解码内存，超过当前截图解析函数的 16,777,216 像素上限；该上限属于截图，素材预检应另定预算。 |

### 涉及文件和依赖关系

- `src/index.ts` 注册现有 15 个工具并串行执行；没有图片导入、二进制图片写入或超分工具。现有退出先等待工具队列，长推理的取消和 EOF 清理必须专门验证，避免再次导致客户端结束后留锁。
- `src/projects.ts` 的 create 复制工程/模板；apply 只接收 UTF-8 文本，不能直接拿它传 PNG。内部 replace 接受 Buffer 文件集合，并提供 expectedRevision、检查点及持久操作日志，可作为将来受控保存候选图片的基础。
- `src/files.ts` 提供相对路径/链接拒绝、哈希、原子写入；现有限制为每工程压缩文件总量 64 MiB / 2000 文件。超分模型、临时输出和比较副本应置于工程之外，避免混入预览、发布包及检查点；压缩字节限制也不能代替解码像素和内存预算。
- `src/native.ts` 的 pngInfo 只验证有界 PNG 头和尺寸；`scripts/png.mjs` 是验收脚本使用的特定 8-bit RGB/RGBA 解码器。它们都不能直接宣称已支持任意输入图片或覆盖完整的输出有效性检查。
- `scripts/build-scene-assets.mjs` 已调用用户安装的官方 resourcecompiler64.exe，但只针对 scene-orbit 模板。Scene 图片超分后还需按对应工程的纹理编译配置重新生成 TEX；不能只替换 PNG 就认定 Scene 已加载高清资源。
- 本机样例的 `portrait.js` 硬编码 1672×941，并以原图像素定义眼睛位置、半径、注视位移和风摆参数；`hair-mask.js` 也按原像素绘制蒙版。`wallpaper.js` 用 image.naturalWidth/naturalHeight 把鼠标映射到图中。直接换成 2 倍图片会触发眼部尺寸拒绝；仅删掉该检查仍会破坏坐标对应。

建议保持“原图逻辑坐标”独立于高清纹理和实际渲染分辨率：眼睛、蒙版、鼠标和位移继续用一致的逻辑坐标，经 UV 映射采样高分辨率图片，渲染画布按显示预算分配。该方案尚未编码或验收，不能只放大纹理而继续以原低分辨率画布输出。普通用户脚本可能有不同坐标约束，通用超分工具应生成候选资产及尺寸变化信息，不能未经检查批量重写任意脚本。

## 不超过四步的实施计划

1. **调研与接入分析（本轮）**：完成候选、维护状态、模型倍率、许可证据、本机硬件和项目约束检查，只保存研究文档。
2. **本机最小对照**：固定官方发行包与模型版本、记录来源及 SHA-256，先对输入副本运行 animevideov3 2 倍和 Real-CUGAN 2 倍保守模型，保留原图与普通插值基线。在相同显示尺寸比较全图、眼睛、细发丝和柔和区域，记录耗时、输出大小、实际尺寸、失败及显存情况；另以小型 RGBA 输入检查透明边缘。先判断是否值得接入，不替换原工程。
3. **MCP 最小接入**：以单个可选本地 CLI 后端生成候选资产，接受受管工程 ID、工程内相对图片路径和白名单模型/倍率；独立校验输出，返回路径、输入/输出哈希、尺寸、后端信息和警告，兼容纯文本客户端。根据第 2 步耗时决定调用形式，加入明确期限、可取消子进程和 EOF 清理回归，不预先搭建完整任务调度系统。保存进工程须显式操作，沿用 revision/检查点和路径边界。
4. **工程与真实引擎验收**：在工程副本适配逻辑坐标/画布；Scene 路径另做官方纹理编译。验收眼睛跟随方向、幅度、头发边缘、色彩、重载、回滚、输出预算和取消退出，最后再决定默认启用范围。超分质量须人工或多模态图像检查；纯文本模型可调用工具和读取证据，但尺寸/哈希不能证明画质提高。

本轮仅完成第 1 步，按项目规则等待用户确认后进入第 2 步。没有把候选命令写成已运行结果，也没有将后续工具名或架构定为既定接口。

## 本轮检查与审查

本轮改动仅 `docs/image-upscaling-research.md`。已读当前工程导入/保存、静态检查、PNG 解析和坐标代码；只读查询 GPU/显存/显示信息、读取样例 PNG 头并查看原图。文档提交前检查差异、链接格式及 git diff --check。未修改产品源码，因此不重复运行上轮已通过的 44 项测试；没有新的推理或画质验收结果。

1. **为何选择**：现有 Windows 子进程模式适合复用独立推理 CLI，先比较对当前插画有针对性的 2 倍模型，可在较少运行依赖下回答画质和兼容性问题。
2. **更简单的实现**：用户手动用 Upscayl 生成高清素材也能改善工作流；需要通过 MCP 让 CLI 模型直接操作时，窄范围的外部程序适配足够，首轮无需移植 GUI、训练模型或托管完整 Python 工作流。
3. **架构与约束**：候选输出和显式保存分开考虑，复用路径、锁、revision 和检查点；推理取消、坐标变换、纹理编译是实际接入约束，不能因原型成功而省略。
4. **临时绕路与技术债**：本轮没有产品改动、隐藏下载或模型打包。老发行包、权重随包许可和本机运行兼容性明确待验，不用品牌、Star 或退出码代替验证。
5. **十倍规模首要限制**：批量图片会先受 GPU 并发、解码/输出内存和候选/检查点存储限制；首版先限制单个推理、输入大小和输出像素，待实测需要再增加队列或缓存。

研究记录的回滚基线为 `b3cc2ed`；撤销本次文档提交即可，无运行状态需要回退。锁恢复的两个人工处理边界按用户已有决定保留，本轮没有继续处理该项。
