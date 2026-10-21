# 自有预览鼠标移动：第 1 步调研

调研日期：2026-10-21。范围是补足受管预览的鼠标移动输入，随后才能验收跟随方向、位移幅度和边缘画面。本步仅阅读源码与一手资料，没有发送鼠标事件，也没有完成真实输入兼容性验收。

本步基线检查：主代理运行 `npm.cmd test`，TypeScript 构建成功，现有 10/10 项测试通过；尚无鼠标工具测试通过的声明。

## 现场与现有实现

- `src/index.ts` 暴露预览打开、属性设置、观察和关闭，未提供鼠标输入工具。
- `src/engine.ts` 持有会话内 previewId → 固定源码副本、窗口身份与 CEF 会话；`verifyWindow` 可复用。`src/cdp.ts` 已有目标发现、私有副本路径匹配、歧义拒绝、固定诊断与通用 `Cdp.call`。
- `native/WeCapture/Program.cs` 已检查 HWND、进程路径、PID、创建时间、窗口类、当前会话和唯一窗口名；当前原生 helper 明确没有输入注入操作。
- 仓库外本地 `../wallpapers/jianyue-afternoon-20261021` 的 manifest 是 Web；`wallpaper.js` 用 `mousemove` 的 `clientX/clientY` 计算全图视差，可作为现有鼠标链路参考。用户已澄清是在制作过程中发现能力缺口，目前没有已完成的眼睛工程；不以寻找既有眼睛作品作为阻塞条件。

## 可复用项目比较

以下 Star 是本次 GitHub 页面实际读取的显示值，部分经过四舍五入；不是 API 精确实时统计。API 请求失败，未把失败结果当作零。维护状态仅描述所见发布/提交，不保证后续维护。

| 项目 | Star | 许可证 / 技术栈 | 功能与维护证据 | 对本项目的取舍 |
| --- | --- | --- | --- | --- |
| [microsoft/playwright](https://github.com/microsoft/playwright) | 约 98.2k | Apache-2.0 / TypeScript | 浏览器自动化，发布页有 v1.64.1；Chromium 源码通过 `Input.dispatchMouseEvent` 发送 mouseMoved。[发布](https://github.com/microsoft/playwright/releases)、[实现](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/chromium/crInput.ts) | 参照目标内 CDP 移动方式；已有 CDP 客户端足够，不引入整个 Playwright。 |
| [FlaUI/FlaUI](https://github.com/FlaUI/FlaUI) | 约 3.2k | MIT / C#、.NET、UI Automation | Windows UI 自动化，发布页有 v5.0.0，含鼠标操作。[发布](https://github.com/FlaUI/FlaUI/releases)、[Mouse 源码](https://github.com/FlaUI/FlaUI/blob/main/src/FlaUI.Core/Input/Mouse.cs) | 可参考 Windows 坐标与原生操作；当前 Web 输入无需 UI Automation 依赖，也不能用它证明 Scene 兼容。 |
| [michaelnoonan/inputsimulator](https://github.com/michaelnoonan/inputsimulator) | 817 | MIT / C#、Win32 SendInput | 封装键鼠系统输入；所见提交历史最新为 2019-08-09，维护活跃度较低。[历史](https://github.com/michaelnoonan/inputsimulator/commits/master/)、[Mouse 源码](https://github.com/michaelnoonan/inputsimulator/blob/master/WindowsInput/MouseSimulator.cs) | 不采用：提供的是系统输入流能力，无法满足“只投递自有预览目标”的边界。 |

决策：在现有服务内增加小范围的 Web CEF 鼠标移动接口，不从零建立桌面自动化系统，也不移植上述框架。Scene 输入作为单独的未验证能力。

## 一手接口事实

### Web CEF：最适合先验证的路径

Chromium 的 `Input.dispatchMouseEvent` 面向页面投递事件，支持 `mouseMoved`。坐标相对于主 frame viewport，单位是 CSS 像素，y 向下；这与本地 Web 样例读取的 client 坐标吻合。[协议定义](https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/Input.pdl)

Playwright 使用同一个 CDP 命令实现 Chromium 鼠标移动，是可参考的实际源码路径；但该事实不能证明 Wallpaper Engine 内置 CEF 的具体版本已支持它，仍需本机调用与画面验收。[Playwright Chromium 输入实现](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/chromium/crInput.ts)

建议首版工具名 `we_preview_move_mouse`，只暴露 `previewId` 和归一化 `x/y`（0..1，左上 0、右下 1），由服务用固定表达式读取当前 `innerWidth/innerHeight`，按 `extent - 1` 换算 CSS 像素。使用当前 viewport，不把打开时要求的窗口尺寸、带标题栏的原生截图尺寸或 Windows DPI 当成页面宽高。事件固定为移动、无按钮和修饰键；不提供点击、滚轮、键盘或任意 CDP 命令、脚本、目标 URL、HWND。

发送前确认原生窗口身份（如果已绑定）、CEF 目标和当前 URL 都属于该预览私有副本；发送后再次检查目标。不存在匹配目标、目标歧义、已关闭、跳转、坐标越界或协议不支持时明确拒绝，绝不自动切换到系统光标。返回应区分“事件命令已确认”和“画面响应已验证”。

### Scene：没有得到定向鼠标注入承诺

官方 SceneScript 输入通过全局 `input` 对象读取，`cursorWorldPosition` 是 2D 壁纸世界坐标，`cursorScreenPosition` 相对壁纸屏幕区域左上角；已查文档没有外部鼠标位置 setter。这不是 `engine.input`。[IInput 官方参考](https://docs.wallpaperengine.io/en/scene/scenescript/reference/class/IInput.html)

官方开发者在 Steam 社区给出的跟随示例也是读取 `input.cursorWorldPosition`；该帖子说明作者侧跟随逻辑，未说明外部投递消息能模拟输入，且发布时间较早，不应据此判断当前引擎版本的输入实现。[开发者讨论](https://steamcommunity.com/app/431960/discussions/2/1638669204737203958/)

Win32 `WM_MOUSEMOVE` 将客户区坐标交给窗口过程。向 HWND 投递它不等于改变真实光标，也不证明应用会从该消息更新 Scene 输入；应用也可能使用其他输入源。只能通过未来受控 Scene 实验确认，不能把消息 API 返回成功视为画面验收。[WM_MOUSEMOVE](https://learn.microsoft.com/en-us/windows/win32/inputdev/wm-mousemove)

`SendInput` 注入系统键鼠输入流，受 UIPI 完整性级别限制；不是按 HWND 定向的鼠标接口。`SetCursorPos` 修改屏幕光标位置，微软明确说明光标是共享资源。两者即使先验证目标窗口，也会影响整个交互桌面；恢复位置还可能覆盖用户同时进行的移动。[SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)、[SetCursorPos](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setcursorpos)

若以后研究原生输入，必须另外处理客户区/非客户区、DPI、多显示器负坐标、缩放、遮挡、最小化、失焦及输入捕获；本次不把它们隐式纳入 Web 接口支持范围。

## 后续三步与验收边界

1. 实现：复用 `Engine` / `Cdp`，增加只接受会话内 previewId 的 Web 移动工具；无 CEF 或 Scene 明确返回不支持。相关位置为 `src/index.ts`、`src/engine.ts`，必要时 `src/cdp.ts`；原生捕获代码应无需变化。
2. 验收：新建最小双眼 Web 测试样例，用真实 STDIO MCP 驱动中心、四方向、四角和多种半径，采集响应后的帧。证明页面收到对应坐标，并验证两个预览只改变指定目标、系统光标不移动、导航和关闭后的请求被拒绝。对样例指定眼睛区域、预期方向、位移上限和遮罩边界，通过诊断及截图测量位置、上限和遮罩外像素变化；视觉自然度仍需人工判断。结果只适用于该样例，不代表任意作品的眼睛边缘变形和视觉质量均能自动判断。
3. 回归与交付：执行相关测试、构建及 Web/原生预览回归，记录工具支持条件和未验收范围，检查 diff 后独立提交。

主要风险是把命令成功当作画面正确、把 Web 支持外推到 Scene、使用错误坐标空间，以及输入落到已跳转或替换的目标。首版通过固定事件类型、会话目标校验、当前 CSS viewport、明确拒绝和实际截图逐项约束。大规模运行时，逐次 viewport/身份查询和串行验收首先增加延迟；在有测量证据前不添加缓存或长驻原生输入进程。
