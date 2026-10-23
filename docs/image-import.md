# 图片检查与原字节导入

2026-10-23。本轮完成超分接入之前的素材入口：检查 PNG/JPEG/WebP，向受管工程导入二进制图片，并支持已有检查点恢复。没有运行超分模型，也没有修改原作品或引擎配置。

## 开源比较与复用决定

Star 为本次网页近似快照，不代表质量保证。

| 项目 | Star | 许可证 / 技术栈 | 维护及适用性 |
| --- | --- | --- | --- |
| [sharp](https://github.com/lovell/sharp) | 约 32.8k | Apache-2.0；JS/TS API、C++、libvips | 官方[版本记录](https://sharp.pixelplumbing.com/changelog/v0.35.5/)列出 0.35.5，2026-09-27；完整解码与元数据 API 文档齐全。本轮固定此版本。 |
| [image-size](https://github.com/image-size/image-size) | 约 2.2k | MIT；JS/TS，无运行依赖 | GitHub 已归档，声明迁至 [Codeberg](https://codeberg.org/image-size/image-size) 维护；只读头部，文档明确损坏图片仍可能返回尺寸，不能满足本次完整解码检查。 |

复用 sharp 的格式识别、元数据和像素解码；只开发本项目需要的目录限制、哈希核对与工程保存适配，没有自行实现通用图片解码器。社区记录亦核对 [sharp #4605](https://github.com/lovell/sharp/issues/4605)，其 extend 限制不等于当前工具的输入预算；本轮没有调用 extend。

sharp 的 [metadata](https://sharp.pixelplumbing.com/api-input/) 本身不解码全部像素，因此还执行 raw 输出解码后丢弃像素缓冲区；保存的是同一输入 Buffer，而非重编码图片。[构造参数](https://sharp.pixelplumbing.com/api-constructor/)设置 failOn:warning 与显式像素上限。npm 的 Windows x64 原生包声明 Apache-2.0 AND LGPL-3.0-or-later，不能把 sharp 顶层许可当作所有原生依赖的许可；本仓库仅记录依赖和锁文件，未复制分发这些二进制。

## 配置及调用

在本机配置中添加允许读取的素材目录；相对路径基于配置文件目录。默认 `assetRoots: []`，不开放任意路径读取。

```json
{"assetRoots":["D:/Wallpaper Assets"]}
```

修改配置并重新启动 MCP 服务后：

```json
{"name":"we_image_inspect","arguments":{"sourceRoot":0,"sourcePath":"portrait.png"}}
```

`sourceRoot` 为 assetRoots 的零基索引。返回格式、存储尺寸、按 EXIF 方向计算的显示尺寸、通道数、透明度、色彩空间、位深、ICC 是否存在、字节数与 SHA256，不返回 EXIF/GPS 原文或图像内容。`hasAlpha` 表示存在透明通道，不保证有非不透明像素。

读取目标工程 revision，然后传入 inspect 返回的源哈希：

```json
{
  "name":"we_image_import",
  "arguments":{
    "projectId":"managed/my-wallpaper",
    "expectedRevision":"<we_project_inspect 返回的 revision>",
    "sourceRoot":0,
    "sourcePath":"portrait.png",
    "expectedSourceHash":"<we_image_inspect 返回的 image.sha256>",
    "targetPath":"images/portrait.png",
    "overwrite":false
  }
}
```

默认拒绝覆盖。显式覆盖仍须使用已有文件及目录的准确大小写、当前源哈希和工程 revision。返回新 revision、checkpointId、素材元数据及下一操作说明；可用 `we_project_restore` 恢复。重复导入完全相同字节且显式覆盖时，沿用现有 replace 的无变更行为，不产生新检查点。

## 边界与影响

- 仅静态 PNG/JPEG/WebP；先检查魔数，APNG / 动画 WebP 拒绝。GIF、SVG、TIFF 等不接收，即使 sharp 底层支持。
- 单文件 20 MiB、单边 8192、总像素 16,777,216。完整解码会临时占用像素内存；压缩字节限制不代表总内存限制。该预算独立于截图模块，首版数值相同，后续必须根据实测调整。
- 仅普通相对路径；拒绝遍历、链接路径、额外硬链接和目录目标。读取使用文件句柄并有界读取，读前后采样属性；导入再核对同一缓冲区哈希。不能防御外部程序恶意并发替换目录，延续已有文件系统信任边界。
- 写入只经 `Projects.resolve(...,true)` 与 `Projects.replace`，外部工程只读；继承工作区锁、revision、候选静态检查、64 MiB / 2000 文件预算、持久检查点和操作日志。新工具也在锁冲突时拒绝调用。
- 目标扩展名必须匹配实际格式，不能用该接口向 JS/JSON 文件写入图片。空目录也参与目标大小写检查。
- 保存原字节，保留原有 EXIF/ICC；不旋转、缩放、去元数据或提高画质。EXIF 方向显示尺寸只是元数据推导，不是各渲染后端一致性的验收。
- 工具不改 HTML/CSS 引用，也不生成 Scene TEX；导入后仍须接入作品并用官方引擎验收。当前原图的 2 倍输出在像素预算内，4 倍输出超限。
- sharp 的 [10 秒 timeout](https://sharp.pixelplumbing.com/api-output/#timeout) 用于像素处理，不是包括文件 I/O、metadata、排队和检查点操作的总墙钟期限；没有独立进程强制终止保障。解码通过不证明画面正确、图片无所有隐藏损坏或主观画质更好。

## 验证记录

命令：

```powershell
npm.cmd test
node scripts/verify-image-import.mjs ".we-mcp/creations/jianyue/data/projects/jianyue-free-breeze-1792648082229/artwork.png"
git diff --check
```

图片专项覆盖 PNG RGBA、JPEG EXIF 方向、静态 WebP、截断输入、APNG、动画 WebP、错误格式、路径遍历、目录链接、硬链接、大小/像素预算、配置默认关闭、格式与扩展名不符、大小写冲突（包括空目录）、默认拒绝覆盖、源哈希变化、过期 revision、原字节保存和检查点恢复。真实 STDIO 回归验证两个工具、纯文本结果、导入/覆盖拒绝/恢复/源未改及退出释放锁；工作区诊断模式测试包含新工具拒绝。

实际原图验收：PNG 1672×941，RGB，1,920,919 字节；SHA256 `70043328b5f9ccab2f7e5c202ab7cf1726f65c107331f2625eee6703077af531`。真实 MCP inspect、创建独立工程、导入、核对落盘哈希、恢复并核对原 revision 均通过，源图未变，锁正常释放。最终代码的原始报告保存在本机忽略目录 `.we-mcp/image-import-verification/ecf16855-6388-4e8e-84f3-4ffac8f3db0e/report.json`，脚本可传其他本地图片复验。

最终 `npm.cmd test` 完成构建及 48/48 测试、0 失败、0 跳过，约 82.8 秒；包含空目录冲突回归。`node --check scripts/verify-image-import.mjs` 和 `git diff --check` 通过。未验收实际超分、画质改善、官方引擎对本轮导入素材的渲染、Scene 编译、16-bit/ICC 色彩保真、极端图片解码超时、读入过程中的恶意并发修改及批量压力。

## 五项代码审查

1. **为什么选此方案**：只读头部不够，sharp 提供维护中的完整解码能力；项目已有二进制 replace、锁和回滚机制，无需第二套文件写入路径。
2. **有没有更简单的实现**：直接复制文件更短，但没有源变更、损坏图和资源预算核对；本轮保留两个窄工具，不增加图片管理器、缓存或任务框架。
3. **架构及隐藏约束**：工程写入仍走既有串行队列和检查点；新目录授权默认关闭。审查发现 Windows 空目录大小写会影响最终落盘路径，已在本轮写前检查并加入回归；导入不会自动改变已有预览快照。
4. **绕路或技术债**：没有按测试样例硬编码图片尺寸、源路径或哈希。固定预算是明确首版范围；进程内解码不是强隔离，timeout 也不是总操作硬期限，这两点仍是已知边界。
5. **十倍规模先在哪里出问题**：串行完整解码、整工程读入及全量检查点先影响延迟、内存和磁盘。需要批量处理时先实测，再决定独立解码进程与存储保留策略，本轮不预建调度系统。

本次代码回滚基线 `adf3861`。出现问题可撤销本次独立提交；已导入的工程素材使用返回的检查点另行恢复，撤销 Git 提交不自动恢复本机工作区。

下一独立步骤仍是固定版本超分后端的本机同图对照，随后再决定 MCP 推理接口；本轮不因导入成功就认定超分已完成。
