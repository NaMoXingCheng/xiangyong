; 相拥 · 关系分析室（抓取版）安装脚本 v0.4.0 —— 内置本地小AI（无 Ollama 依赖）
;
; 打包流程：
;   1) 生成干净的源目录  E:\相拥-打包版   （由项目里的打包脚本产出，只含运行时文件）
;   2) 用 Inno Setup 编译本脚本
#define MyAppName "相拥 · 关系分析室"
#define MyAppVersion "0.4.0"
#define MyAppExeName "electron.exe"
#define MyAppId "XY-REL-ANALYZER-2026"
; 待打包的干净源目录（中文顶层目录，方便一眼找到）
#define SrcDir "E:\相拥-打包版"

[Setup]
AppId={{XY-REL-ANALYZER-2026}}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher=xiangyong
; 装到 localappdata 而不是 Program Files，有两个原因：
;   1) 免管理员权限（PrivilegesRequired=lowest）
;   2) 应用要往自己目录写 data/（导入的聊天记录 + 下载的模型），Program Files 下写不了
; 这里刻意用 ASCII 路径：node-llama-cpp 要从安装目录加载原生 DLL，
; 中文路径在个别环境会让 DLL 加载失败，不值得为好看冒这个险。
DefaultDirName={localappdata}\ta-love-app-grab
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=C:\Users\35873\Desktop
OutputBaseFilename=相拥-安装包
SetupIconFile={#SrcDir}\app.ico
UninstallDisplayIcon={app}\app\app.ico
Compression=lzma2
SolidCompression=yes
WizardStyle=modern

[Languages]
Name: "ChineseSimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Files]
; Excludes 是**安全网**，不是可选项：应用的 data/ 里放着用户的聊天记录和几个 GB 的模型，
; 一旦被卷进安装包，等于把别人的隐私和自己的私聊一起发出去了。
; 源目录本来就应该已经清干净，这里再挡一道，防止以后打包时手滑。
Source: "{#SrcDir}\*"; DestDir: "{app}\app"; \
  Excludes: "data,data\*,*.log,*.out,截图\*,测试脚本\*,工具\*,temp\*,node_modules\.cache\*"; \
  Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\app\node_modules\electron\dist\electron.exe"; Parameters: "--no-sandbox ""{app}\app"""; WorkingDir: "{app}\app"; IconFilename: "{app}\app\app.ico"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\app\node_modules\electron\dist\electron.exe"; Parameters: "--no-sandbox ""{app}\app"""; WorkingDir: "{app}\app"; IconFilename: "{app}\app\app.ico"; Tasks: desktopicon
Name: "{autoprograms}\卸载 {#MyAppName}"; Filename: "{uninstallexe}"; IconFilename: "{app}\app\app.ico"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务:"

[Run]
Filename: "{app}\app\node_modules\electron\dist\electron.exe"; Parameters: "--no-sandbox ""{app}\app"""; WorkingDir: "{app}\app"; Description: "立即启动 相拥 · 关系分析室"; Flags: nowait postinstall skipifsilent

; 卸载时**不**删 {app}\app\data：那是用户导入的聊天记录和下载的模型，不属于安装产物。
; Inno 默认只删自己装过的文件，未被安装的额外文件会留下（目录非空也就不会被移除），
; 所以这里不需要额外声明 —— 写这段是为了说明「不删是有意为之」，别以后顺手加 [UninstallDelete]。
