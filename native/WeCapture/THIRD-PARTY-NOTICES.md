# Capture helper source attribution

`Interop.cs` adapts the D3D11 device and HWND capture-item interop from
[Backdrop for Codex](https://github.com/TogawaSakiko-desuwa/backdrop-for-codex),
`WindowsGraphicsCaptureFactory.cs` at commit
`cf4e9f9b083a702a95cd280e2fe8b5d86ce6e56e`.
That adapted file remains Apache-2.0. The complete upstream license and notice
are preserved in `LICENSE.Apache-2.0` and `UPSTREAM-NOTICE`. Changes are identified
in the file header. Other original project files remain under the root MIT license.

The ownership approach also references Backdrop's
`WallpaperEngineOwnedWindowVerifier.cs`: pre-launch HWND baseline, exact generated
title, process/session/path/start-time identity and revalidation. This helper does
not import Backdrop Core or its streaming/codec dependencies. It does not claim
Backdrop's Authenticode trust verification; the configured installation is a local
trust boundary, not protection against malicious same-user processes.

The single-frame free-threaded WGC flow was also studied in
[robmikh/Win32CaptureSample](https://github.com/robmikh/Win32CaptureSample/blob/49fefe79fd9b11025f0b5eb91783a98888516070/Win32CaptureSample/CaptureSnapshot.cpp)
(MIT). No C++ sample source is copied into this helper.

Runtime/build dependencies supplied by Microsoft's .NET SDK and Windows SDK
projection retain their own package licenses. The Windows SDK projection is
pinned to 10.0.19041.57 in `WeCapture.csproj`.
Redistributions of helper binaries must include this notice, the root MIT license,
and applicable third-party license/notice files.
