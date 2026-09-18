@echo off
rem 启动「相拥 · 关系分析室」
rem 这里不要再加 --disable-gpu / --in-process-gpu。
rem 那会让界面退回 CPU 软件渲染，实测帧间隔从 6ms 恶化到 57ms（约 17fps），肉眼可见地卡。
rem 渲染模式由 electron-main.js 统一决定，它还会主动摘掉外部传进来的这类开关。
cd /d "%~dp0"
start "" "%~dp0node_modules\electron\dist\electron.exe" --no-sandbox .
