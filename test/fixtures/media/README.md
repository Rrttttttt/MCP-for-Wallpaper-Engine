# Synthetic media fixtures

Generated locally from a 440 Hz sine wave and a flat blue 64x48 frame. No user artwork, downloaded movie or external audio is included. The MP3 title `PRIVATE-METADATA-SENTINEL` checks that private tags are omitted from tool results.

Generation used the optional development-only encoder from npm `@ffmpeg-installer/win32-x64@4.1.0`, FFmpeg `N-92722-gf22fcd4483` (2018 build), executable SHA256 `c8abc49e7be62dde8e12972af373959e0076a7b8dc8040eb45978e0608f8781e`. Its package reports GPLv3. The archive and executable stay in the ignored `.we-mcp/tools/media-fixtures/` directory; neither is a runtime dependency or committed here. This old encoder was used only for fixed synthetic inputs, not arbitrary user media. Tests consume these tiny committed outputs and do not require FFmpeg.

Equivalent generation commands, with an available FFmpeg executable (binary output may differ by version):

```powershell
ffmpeg -hide_banner -loglevel error -nostdin -y -f lavfi -i 'sine=frequency=440:sample_rate=16000:duration=0.25' -c:a pcm_s16le tone.wav
ffmpeg -hide_banner -loglevel error -nostdin -y -i tone.wav -codec:a libmp3lame -b:a 64k -metadata title=PRIVATE-METADATA-SENTINEL tone.mp3
ffmpeg -hide_banner -loglevel error -nostdin -y -f lavfi -i 'color=c=blue:s=64x48:r=10:d=0.4' -i tone.wav -c:v libx264 -pix_fmt yuv420p -c:a aac -movflags +faststart clip.mp4
ffmpeg -hide_banner -loglevel error -nostdin -y -f lavfi -i 'color=c=blue:s=64x48:r=10:d=0.4' -c:v libvpx-vp9 -an clip.webm
```

| File | Bytes | SHA256 |
| --- | --- | --- |
| tone.wav | 8078 | 363d6aed496e8fe313b809f094df78358e60a795adcbd5df621fb7c9cd49c903 |
| tone.mp3 | 2962 | 48ec3cf3dc0d093e7b28e41943c5b0b06e328651ab3721e4df203eb5c29dc80d |
| clip.mp4 | 4524 | 42b1725fa4dbcc6bbaa2a17281f831ec9fe84d5b2882d27364d15a8192063263 |
| clip.webm | 779 | f566be156889b225b0bd1254faf71f1860704a791ff481d849fbaebec00f19ce |

Container duration can include codec delay/padding. These fixtures test metadata and byte preservation; passing does not prove engine playback.
